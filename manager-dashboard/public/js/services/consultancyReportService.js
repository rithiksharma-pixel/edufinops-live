// =========================================================
// SERVICE LAYER — Consultancy reporting
//
// Both RPCs run SECURITY INVOKER, so RLS decides what the caller sees:
// an Admin gets every consultancy, a Manager gets whatever their role can
// read. There is deliberately no role handling in this file — the database
// is the scoping boundary, same as milestoneService.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

/**
 * One row per consultancy for the given window (null = all time).
 * @returns {Promise<Array>} ordered by total_leads desc, as the RPC returns it
 */
export const REPORT_DATE_FIELDS = {
  created_at: 'Created', updated_at: 'Last modified', login_date: 'Login',
  sanction_date: 'Sanction', pf_date: 'PF', disbursed_date: 'Disbursement',
};

export async function getConsultancyReport(from = null, to = null, dateField = 'created_at') {
  const { data, error } = await supabase.rpc('consultancy_report', {
    p_from: from || null,
    p_to: to || null,
    // Whitelisted client-side too, so a stale value can never reach the RPC.
    p_date_field: REPORT_DATE_FIELDS[dateField] ? dateField : 'created_at',
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * The leads behind one report row. A consultancy that exists as a proper
 * record is identified by id; one that only ever appeared as free text in
 * `consultancy_other_name` has no id, so it is matched by name instead —
 * which is why both arguments exist and exactly one is populated.
 */
export async function getConsultancyLeads(row, from = null, to = null, dateField = 'created_at') {
  const { data, error } = await supabase.rpc('consultancy_lead_detail', {
    p_consultancy_id: row.consultancy_id || null,
    p_consultancy_name: row.consultancy_id ? null : row.consultancy_name,
    p_from: from || null,
    p_to: to || null,
    p_date_field: REPORT_DATE_FIELDS[dateField] ? dateField : 'created_at',
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * One row per BD manager for the given window.
 *
 * Attribution is done in the RPC, not here: a lead resolves to a BD person by
 * leads.bd_name first, then by the bd_manager of its consultancy. See
 * migration 050 for why the fallback is necessary (bd_name is set on ~3% of
 * the book; the consultancy's bd_manager covers ~45%).
 *
 * The row with bd_manager === null is the Unattributed bucket. It is returned
 * on purpose so the page can show it — dropping it would inflate every BD
 * person's apparent share and stop the totals reconciling with Lead Management.
 */
export async function getBdReport(from = null, to = null, dateField = 'created_at') {
  const { data, error } = await supabase.rpc('bd_report', {
    p_from: from || null,
    p_to: to || null,
    p_date_field: REPORT_DATE_FIELDS[dateField] ? dateField : 'created_at',
  });
  if (error) throw error;
  return data ?? [];
}

/** The leads behind one BD row. Pass the row whose bd_manager may be null —
 *  the RPC matches that with IS NOT DISTINCT FROM, so null selects the
 *  Unattributed bucket rather than returning nothing. */
export async function getBdLeads(row, from = null, to = null, dateField = 'created_at') {
  const { data, error } = await supabase.rpc('bd_lead_detail', {
    p_bd_manager: row.bd_manager || null,
    p_from: from || null,
    p_to: to || null,
    p_date_field: REPORT_DATE_FIELDS[dateField] ? dateField : 'created_at',
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * Conversion percentages between funnel steps.
 *
 * Each rate is against the step above it, not against total leads — "of the
 * ones that reached Login, how many got sanctioned" is the question a
 * consultancy actually asks. Guarded against divide-by-zero, which is common
 * here because most consultancies have no disbursements yet.
 */
export function conversionRates(r) {
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  return {
    leadToLogin: pct(r.login, r.total_leads),
    loginToSanction: pct(r.sanction, r.login),
    sanctionToPf: pct(r.pf_paid, r.sanction),
    pfToDisbursement: pct(r.disbursement, r.pf_paid),
    leadToDisbursement: pct(r.disbursement, r.total_leads),
  };
}

/** Rows -> CSV text. Values are quoted and internal quotes doubled, so a
 *  consultancy name containing a comma cannot shift every later column. */
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(',')).join('\n');
  return `${head}\n${body}`;
}

/** Download any text as a file. downloadCsv is CSV-specific; this carries the
 *  right MIME type so a shared HTML report opens in a browser rather than
 *  being offered as a plain-text download. */
export function downloadText(text, filename, mime = 'text/html;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Escapes for HTML text nodes. This runs over CRM data that is going into a
 *  file sent OUTSIDE the company, so a student name containing markup must
 *  never become markup in the recipient's browser. */
function h(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const inr = (v) => (Number(v || 0) ? `₹${Number(v).toLocaleString('en-IN')}` : '–');
const num = (v) => Number(v || 0).toLocaleString('en-IN');
const showPct = (v) => (v === null ? '–' : `${v}%`);

/**
 * A self-contained HTML report for one consultancy — the dashboard numbers
 * AND the lead rows, in one file with no external assets, so it survives
 * being emailed or dropped in a shared drive.
 *
 * Deliberately plain and print-friendly: this goes to an outside partner,
 * so it states what the numbers mean and where they are weak rather than
 * presenting them as more solid than they are.
 */
export function buildPartnerReportHtml(row, leads, { from, to, generatedOn, basis, title } = {}) {
  const c = conversionRates(row);
  // The same builder serves the BD tab, whose rows have no consultancy_name.
  // Callers pass `title` explicitly there; consultancy rows keep the default.
  const subject = title || row.consultancy_name;
  // Name the basis: "leads created in August" and "leads that logged in during
  // August" are different questions with different answers.
  const range = from || to
    ? `${basis || 'Created'} date ${from || 'any time'} to ${to || 'today'}`
    : 'All leads, all time';

  const funnel = [
    ['Leads received', row.total_leads],
    ['Reached Login', row.login],
    ['Reached Sanction', row.sanction],
    ['Reached PF Paid', row.pf_paid],
    ['Disbursed', row.disbursement],
    ['Lost', row.lost],
  ];

  const steps = [
    ['Lead → Login', c.leadToLogin],
    ['Login → Sanction', c.loginToSanction],
    ['Sanction → PF Paid', c.sanctionToPf],
    ['PF Paid → Disbursement', c.pfToDisbursement],
    ['Lead → Disbursement (overall)', c.leadToDisbursement],
  ];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(subject)} — Zolve Tangent report</title>
<style>
  :root{--ink:#14181f;--mut:#6b7482;--rule:#e2e5eb;--bg:#fff;--sunk:#f5f6f8;--acc:#1f4e6b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--mut);font-size:14px;margin:0 0 26px}
  h2{font-size:16px;margin:34px 0 12px;letter-spacing:-.01em}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .card{border:1px solid var(--rule);border-radius:6px;padding:14px 16px}
  .card b{display:block;font-size:24px;font-variant-numeric:tabular-nums;line-height:1.1}
  .card span{font-size:12px;color:var(--mut)}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule)}
  th{background:var(--sunk);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
  .scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:6px}
  .note{background:var(--sunk);border-left:3px solid var(--acc);padding:12px 14px;border-radius:4px;
        font-size:13px;color:#3d4551;margin:22px 0}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--rule);font-size:12px;color:var(--mut)}
  @media print{.wrap{padding:0}body{font-size:12px}}
</style></head><body><div class="wrap">

<h1>${h(subject)}</h1>
<p class="sub">Zolve Tangent pipeline report · ${h(range)} · generated ${h(generatedOn)}</p>

<h2>Pipeline</h2>
<div class="cards">
  ${funnel.map(([l, v]) => `<div class="card"><b>${num(v)}</b><span>${h(l)}</span></div>`).join('')}
</div>

<h2>Conversion</h2>
<div class="scroll"><table>
  <thead><tr><th>Step</th><th class="n">Rate</th></tr></thead>
  <tbody>${steps.map(([l, v]) => `<tr><td>${h(l)}</td><td class="n">${showPct(v)}</td></tr>`).join('')}</tbody>
</table></div>

<h2>Value &amp; ageing</h2>
<div class="scroll"><table><tbody>
  <tr><td>Applications created with lenders</td><td class="n">${num(row.deals_created)}</td></tr>
  <tr><td>Sanctioned amount</td><td class="n">${inr(row.sanctioned_amount)}</td></tr>
  <tr><td>Disbursed amount</td><td class="n">${inr(row.disbursed_amount)}</td></tr>
  <tr><td>Average days since last activity</td><td class="n">${row.avg_age_days ?? '–'}</td></tr>
</tbody></table></div>

<div class="note">
  <strong>How to read this.</strong> Pipeline counts are by each lead's <em>current</em> stage,
  so a lead that reached Login and was later lost appears only under Lost. Sanctioned and
  disbursed amounts are recorded only where a lender application exists in the CRM, so they
  understate cases settled outside it. Ageing is measured from the last recorded activity.
</div>

<h2>Leads (${num(leads.length)})</h2>
${leads.length ? `<div class="scroll"><table>
  <thead><tr><th>Student</th><th>Phone</th><th>Stage</th><th>Relationship manager</th>
  <th class="n">Days idle</th></tr></thead>
  <tbody>${leads.map((l) => `<tr>
    <td>${h(l.student_name)}</td><td>${h(l.student_phone)}</td><td>${h(l.stage)}</td>
    <td>${h(l.assigned_rm || 'Unassigned')}</td><td class="n">${l.days_idle ?? '–'}</td>
  </tr>`).join('')}</tbody></table></div>` : '<p class="sub">No leads in this range.</p>'}

<footer>Generated from Zolve Tangent. Figures reflect the CRM at the time of generation.</footer>
</div></body></html>`;
}
