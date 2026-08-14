// =========================================================
// Partner Reports — consultancy-wise funnel, conversion and ageing.
//
// The whole report is one RPC call. Filtering, sorting and search happen on
// the returned rows rather than by re-querying: there are ~616 consultancies,
// so the entire report is a few tens of KB and round-tripping the database
// for a text search would be slower and no more correct.
// =========================================================
import { getCurrentUser } from './services/authService.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { downloadCsv } from '../../../authentication/public/js/services/exportImportService.js';
import {
  getConsultancyReport, getConsultancyLeads, getBdReport, getBdLeads,
  conversionRates, toCsv, downloadText, buildPartnerReportHtml, REPORT_DATE_FIELDS,
} from './services/consultancyReportService.js';

const state = {
  tab: 'consultancy',
  rows: [], bdRows: [],
  from: '', to: '', consultancy: '', bd: '', min: 0, dateField: 'created_at',
  // Independent per tab: sorting by "Consultancies" makes no sense on the
  // consultancy table, so the two must not share a key.
  sort: { consultancy: { key: 'total_leads', dir: 'desc' }, bd: { key: 'total_leads', dir: 'desc' } },
};

/** Label for the Unattributed bucket, which the RPC returns as a null name. */
const UNATTRIBUTED = 'Unattributed';
const bdLabel = (r) => r.bd_manager || UNATTRIBUTED;

const n = (v) => Number(v || 0).toLocaleString('en-IN');
const pct = (v) => (v === null ? '–' : `${v}%`);

/** Money, but only when there is any — a column of "₹0" reads as a bug. */
function money(v) {
  const num = Number(v || 0);
  if (!num) return '–';
  return `₹${num.toLocaleString('en-IN')}`;
}

/**
 * Sort key -> value. Plain columns read straight off the row; the conversion
 * columns are derived, so they need computing before they can be compared.
 * Sorting the rendered "12.5%" text would sort lexically and put 9% after 12%.
 */
function sortValue(row, key) {
  if (key === 'leadToLogin' || key === 'leadToDisbursement') return conversionRates(row)[key];
  if (key === 'bd_manager') return bdLabel(row);
  return row[key];
}

/**
 * Sorts in place on a copy. Nulls always sink to the bottom regardless of
 * direction — a consultancy with no conversion yet is not "the best" just
 * because you clicked ascending.
 */
function applySort(rows, { key, dir }) {
  if (!key) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    const xn = x === null || x === undefined || x === '';
    const yn = y === null || y === undefined || y === '';
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    if (typeof x === 'string' || typeof y === 'string') {
      return String(x).localeCompare(String(y), 'en', { sensitivity: 'base' }) * sign;
    }
    return (Number(x) - Number(y)) * sign;
  });
}

/** Paints the arrow on the active column and clears the rest. */
function paintSortHeaders(tableId, sort) {
  document.querySelectorAll(`#${tableId} thead th[data-sort]`).forEach((th) => {
    const active = th.dataset.sort === sort.key;
    th.classList.toggle('sorted', active);
    th.dataset.dir = active ? sort.dir : '';
    th.setAttribute('aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

/** Click a header to sort by it; click the active one again to flip direction.
 *  First click on a new column is descending, because "who has the most" is
 *  the question being asked far more often than "who has the least". */
function wireSorting(tableId, tabKey, rerender) {
  document.querySelectorAll(`#${tableId} thead th[data-sort]`).forEach((th) => {
    th.tabIndex = 0;
    const go = () => {
      const sort = state.sort[tabKey];
      const key = th.dataset.sort;
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else { sort.key = key; sort.dir = 'desc'; }
      rerender();
    };
    th.addEventListener('click', go);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
}

function visibleRows() {
  const rows = state.rows.filter((r) =>
    (r.total_leads >= state.min) &&
    (!state.consultancy || r.consultancy_name === state.consultancy));
  return applySort(rows, state.sort.consultancy);
}

function visibleBdRows() {
  const rows = state.bdRows.filter((r) =>
    (r.total_leads >= state.min) &&
    (!state.bd || bdLabel(r) === state.bd));
  return applySort(rows, state.sort.bd);
}

/**
 * Rebuilds the consultancy dropdown from whatever the report returned, so it
 * can only ever offer names that actually have leads in the selected range.
 * Keeps the current selection if it survives the new range, otherwise falls
 * back to "All" rather than silently showing an empty table.
 */
function populateConsultancyDropdown() {
  const sel = document.getElementById('repConsultancy');
  const previous = state.consultancy;

  const names = [...state.rows]
    .sort((a, b) => (a.consultancy_name || '').localeCompare(b.consultancy_name || '', 'en'));

  sel.innerHTML = `<option value="">All consultancies (${names.length})</option>`
    + names.map((r) => `<option value="${escapeHtml(r.consultancy_name)}">`
        + `${escapeHtml(r.consultancy_name)} — ${n(r.total_leads)}`
        + `${r.is_linked ? '' : ' (unlinked)'}</option>`).join('');

  const stillThere = previous && names.some((r) => r.consultancy_name === previous);
  state.consultancy = stillThere ? previous : '';
  sel.value = state.consultancy;
}

/**
 * Funnel totals across every row currently visible.
 *
 * Summed from the rows already on screen rather than re-queried, so the cards
 * and the table can never disagree — and so the consultancy and min-leads
 * filters (which are applied client-side) are reflected without a round trip.
 *
 * Conversion is computed from the SUMMED counts, not by averaging each
 * consultancy's percentage. Averaging percentages would let a consultancy
 * with 2 leads weigh as heavily as one with 200.
 */
function renderTotals(rows) {
  const el = document.getElementById('repTotals');
  if (!el) return;

  const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const t = {
    total_leads: sum('total_leads'),
    login: sum('login'),
    sanction: sum('sanction'),
    pf_paid: sum('pf_paid'),
    disbursement: sum('disbursement'),
    lost: sum('lost'),
  };
  const c = conversionRates(t);

  const cards = [
    ['Leads', t.total_leads, null],
    ['Login', t.login, c.leadToLogin],
    ['Sanction', t.sanction, c.loginToSanction],
    ['PF Paid', t.pf_paid, c.sanctionToPf],
    ['Disbursement', t.disbursement, c.pfToDisbursement],
    ['Lost', t.lost, null],
  ];

  el.innerHTML = cards.map(([label, value, rate]) => `
    <div class="funnel-card">
      <span class="count">${n(value)}</span>
      <span class="label">${label}</span>
      ${rate === null ? '' : `<span class="funnel-rate">${pct(rate)} of previous</span>`}
    </div>`).join('')
    + `<div class="funnel-card funnel-card-overall">
         <span class="count">${pct(c.leadToDisbursement)}</span>
         <span class="label">Lead → Disbursement</span>
       </div>`;
}

function render() {
  const body = document.getElementById('repBody');
  const rows = visibleRows();
  renderTotals(rows);
  paintSortHeaders('repTable', state.sort.consultancy);

  document.getElementById('repCount').innerHTML =
    `<strong>${n(rows.length)}</strong> ${rows.length === 1 ? 'consultancy' : 'consultancies'}`
    + `<span class="lead-count-filters"> · ${n(rows.reduce((s, r) => s + Number(r.total_leads), 0))} leads`
    + (state.from || state.to ? ` · ${REPORT_DATE_FIELDS[state.dateField]} ${state.from || '…'} → ${state.to || '…'}` : '')
    + (state.consultancy ? ` · ${escapeHtml(state.consultancy)}` : '')
    + '</span>';

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11">${emptyState('fa-handshake', 'No consultancies match', 'Try clearing the consultancy, the date range, or the minimum-leads filter.')}</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r, i) => {
    const c = conversionRates(r);
    // A consultancy that only ever appeared as free text has no record to
    // link a portal to later, so it is worth seeing at a glance.
    const freetext = r.is_linked ? '' : ' <span class="badge" title="Only ever entered as free text — no consultancy record exists">unlinked</span>';
    return `
      <tr data-i="${i}" class="rep-row">
        <td><div class="student-name">${escapeHtml(r.consultancy_name)}${freetext}</div></td>
        <td class="num">${n(r.total_leads)}</td>
        <td class="num">${n(r.login)}</td>
        <td class="num">${n(r.sanction)}</td>
        <td class="num">${n(r.pf_paid)}</td>
        <td class="num">${n(r.disbursement)}</td>
        <td class="num muted">${n(r.lost)}</td>
        <td class="num">${pct(c.leadToLogin)}</td>
        <td class="num">${pct(c.leadToDisbursement)}</td>
        <td class="num">${r.avg_age_days ?? '–'}d</td>
        <td><i class="fa-solid fa-chevron-right" style="color:var(--ink-300)"></i></td>
      </tr>`;
  }).join('');

  body.querySelectorAll('.rep-row').forEach((tr) => {
    tr.addEventListener('click', () => openDetail(rows[Number(tr.dataset.i)]));
  });
}

/** Rebuilds the BD dropdown from whatever the report returned, same contract
 *  as the consultancy one: it can only offer people with leads in range. */
function populateBdDropdown() {
  const sel = document.getElementById('repBd');
  const previous = state.bd;
  const names = [...state.bdRows].sort((a, b) => bdLabel(a).localeCompare(bdLabel(b), 'en'));

  sel.innerHTML = `<option value="">All BD managers (${names.length})</option>`
    + names.map((r) => `<option value="${escapeHtml(bdLabel(r))}">`
        + `${escapeHtml(bdLabel(r))} — ${n(r.total_leads)}</option>`).join('');

  const stillThere = previous && names.some((r) => bdLabel(r) === previous);
  state.bd = stillThere ? previous : '';
  sel.value = state.bd;
}

function renderBd() {
  const body = document.getElementById('bdBody');
  const rows = visibleBdRows();
  renderTotals(rows);
  paintSortHeaders('bdTable', state.sort.bd);

  document.getElementById('bdCount').innerHTML =
    `<strong>${n(rows.length)}</strong> BD ${rows.length === 1 ? 'manager' : 'managers'}`
    + `<span class="lead-count-filters"> · ${n(rows.reduce((s, r) => s + Number(r.total_leads), 0))} leads`
    + (state.from || state.to ? ` · ${REPORT_DATE_FIELDS[state.dateField]} ${state.from || '…'} → ${state.to || '…'}` : '')
    + (state.bd ? ` · ${escapeHtml(state.bd)}` : '')
    + '</span>';

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="12">${emptyState('fa-user-tie', 'No BD managers match', 'Try clearing the BD, the date range, or the minimum-leads filter.')}</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r, i) => {
    const c = conversionRates(r);
    // The unattributed bucket is a data gap, not a person. Marked so nobody
    // reads it as someone's book or puts it in a review deck by mistake.
    const unattributed = r.bd_manager
      ? ''
      : ' <span class="badge" title="No bd_name on the lead and no BD manager on its consultancy — mostly bulk-imported leads">no BD on record</span>';
    return `
      <tr data-i="${i}" class="bd-row">
        <td><div class="student-name">${escapeHtml(bdLabel(r))}${unattributed}</div></td>
        <td class="num muted">${n(r.consultancies)}</td>
        <td class="num">${n(r.total_leads)}</td>
        <td class="num">${n(r.login)}</td>
        <td class="num">${n(r.sanction)}</td>
        <td class="num">${n(r.pf_paid)}</td>
        <td class="num">${n(r.disbursement)}</td>
        <td class="num muted">${n(r.lost)}</td>
        <td class="num">${pct(c.leadToLogin)}</td>
        <td class="num">${pct(c.leadToDisbursement)}</td>
        <td class="num">${r.avg_age_days ?? '–'}d</td>
        <td><i class="fa-solid fa-chevron-right" style="color:var(--ink-300)"></i></td>
      </tr>`;
  }).join('');

  body.querySelectorAll('.bd-row').forEach((tr) => {
    tr.addEventListener('click', () => openBdDetail(rows[Number(tr.dataset.i)]));
  });
}

const SUMMARY_COLUMNS = [
  { label: 'Consultancy', get: (r) => r.consultancy_name },
  { label: 'Has CRM record', get: (r) => (r.is_linked ? 'Yes' : 'No') },
  { label: 'Total leads', get: (r) => r.total_leads },
  { label: 'Reached Login', get: (r) => r.login },
  { label: 'Reached Sanction', get: (r) => r.sanction },
  { label: 'Reached PF Paid', get: (r) => r.pf_paid },
  { label: 'Reached Disbursement', get: (r) => r.disbursement },
  { label: 'Lost', get: (r) => r.lost },
  { label: 'Lead to Login %', get: (r) => conversionRates(r).leadToLogin },
  { label: 'Login to Sanction %', get: (r) => conversionRates(r).loginToSanction },
  { label: 'Sanction to PF %', get: (r) => conversionRates(r).sanctionToPf },
  { label: 'Lead to Disbursement %', get: (r) => conversionRates(r).leadToDisbursement },
  { label: 'Deals created', get: (r) => r.deals_created },
  { label: 'Sanctioned amount', get: (r) => r.sanctioned_amount },
  { label: 'Disbursed amount', get: (r) => r.disbursed_amount },
  { label: 'Avg days since activity', get: (r) => r.avg_age_days },
];

const LEAD_COLUMNS = [
  { label: 'Student', get: (r) => r.student_name },
  { label: 'Phone', get: (r) => r.student_phone },
  { label: 'Email', get: (r) => r.student_email },
  { label: 'Stage', get: (r) => r.stage },
  { label: 'Assigned RM', get: (r) => r.assigned_rm || 'Unassigned' },
  { label: 'Loan amount', get: (r) => r.loan_amount },
  { label: 'Created', get: (r) => r.created_on },
  { label: 'Last activity', get: (r) => r.last_activity },
  { label: 'Days idle', get: (r) => r.days_idle },
];

/** Filename-safe, so a consultancy called "A/B & Co." can't break the download. */
const slug = (s) => (s || 'consultancy').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);

async function openDetail(row) {
  // Only the overlay is toggled — the drawer lives inside it.
  document.getElementById('repOverlay').hidden = false;

  document.getElementById('repDrawerName').textContent = row.consultancy_name;
  const c = conversionRates(row);
  document.getElementById('repDrawerSub').textContent =
    `${n(row.total_leads)} leads · ${pct(c.leadToLogin)} reach Login · ${pct(c.leadToDisbursement)} reach Disbursement`;

  const bodyEl = document.getElementById('repDrawerBody');
  bodyEl.innerHTML = `
    <div class="funnel-row" style="margin-bottom:18px;">
      ${[['Leads', row.total_leads], ['Login', row.login], ['Sanction', row.sanction],
         ['PF Paid', row.pf_paid], ['Disbursement', row.disbursement], ['Lost', row.lost]]
        .map(([label, v]) => `<div class="funnel-card"><span class="count">${n(v)}</span><span class="label">${label}</span></div>`).join('')}
    </div>
    <div class="report-kv">
      <div><span>Login → Sanction</span><strong>${pct(c.loginToSanction)}</strong></div>
      <div><span>Sanction → PF</span><strong>${pct(c.sanctionToPf)}</strong></div>
      <div><span>PF → Disbursement</span><strong>${pct(c.pfToDisbursement)}</strong></div>
      <div><span>Deals created</span><strong>${n(row.deals_created)}</strong></div>
      <div><span>Sanctioned</span><strong>${money(row.sanctioned_amount)}</strong></div>
      <div><span>Disbursed</span><strong>${money(row.disbursed_amount)}</strong></div>
      <div><span>Avg days since activity</span><strong>${row.avg_age_days ?? '–'}d</strong></div>
    </div>
    <div style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap;">
      <button class="btn btn-primary" id="repExportReport" disabled><i class="fa-solid fa-file-lines"></i> Share report (dashboard + leads)</button>
      <button class="btn btn-ghost" id="repExportLeads" disabled><i class="fa-solid fa-download"></i> Export leads (CSV)</button>
    </div>
    <h3 style="margin:18px 0 8px;">Leads</h3>
    <div id="repLeads"><div class="spinner-block"><span class="spinner"></span><span>Loading leads…</span></div></div>
  `;

  // Wired BEFORE the fetch, against a mutable array. Previously these were
  // attached after it, so any failure took an early return and left a button
  // that rendered but did nothing when clicked.
  let leads = [];
  const btnReport = document.getElementById('repExportReport');
  const btnCsv = document.getElementById('repExportLeads');

  btnCsv.addEventListener('click', () => {
    downloadCsv(toCsv(leads, LEAD_COLUMNS), `${slug(row.consultancy_name)}-leads.csv`);
    showToast(`Exported ${leads.length} leads`);
  });
  btnReport.addEventListener('click', () => {
    const html = buildPartnerReportHtml(row, leads, {
      from: state.from, to: state.to, basis: REPORT_DATE_FIELDS[state.dateField],
      generatedOn: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    });
    downloadText(html, `${slug(row.consultancy_name)}-report.html`);
    showToast('Report downloaded — open it in a browser or send it on');
  });

  try {
    leads = await getConsultancyLeads(row, state.from, state.to, state.dateField);
  } catch (err) {
    console.error('consultancy lead detail failed', err);
    document.getElementById('repLeads').innerHTML =
      `<p class="empty-state">Could not load the lead list.<br>
       <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span></p>`;
    // The summary numbers came from the row we already have, so the report is
    // still worth exporting — just without the lead list.
    btnReport.disabled = false;
    return;
  }
  btnReport.disabled = false;
  btnCsv.disabled = false;

  document.getElementById('repLeads').innerHTML = leads.length
    ? `<div style="overflow-x:auto;"><table class="lead-table"><thead><tr>
         <th>Student</th><th>Stage</th><th>RM</th><th class="num">Days idle</th></tr></thead><tbody>
         ${leads.map((l) => `<tr>
           <td><div class="student-name">${escapeHtml(l.student_name)}</div>
               <div class="student-phone">${escapeHtml(l.student_phone || '')}</div></td>
           <td><span class="badge badge-accent">${escapeHtml(l.stage)}</span></td>
           <td>${escapeHtml(l.assigned_rm || 'Unassigned')}</td>
           <td class="num">${l.days_idle ?? '–'}</td>
         </tr>`).join('')}
       </tbody></table></div>`
    : '<p class="empty-state">No leads in this date range.</p>';

  document.getElementById('repExportLeads').addEventListener('click', () => {
    downloadCsv(toCsv(leads, LEAD_COLUMNS), `${slug(row.consultancy_name)}-leads.csv`);
    showToast(`Exported ${leads.length} leads`);
  });
}

const BD_SUMMARY_COLUMNS = [
  { label: 'BD manager', get: (r) => bdLabel(r) },
  { label: 'Consultancies', get: (r) => r.consultancies },
  { label: 'Total leads', get: (r) => r.total_leads },
  { label: 'Reached Login', get: (r) => r.login },
  { label: 'Reached Sanction', get: (r) => r.sanction },
  { label: 'Reached PF Paid', get: (r) => r.pf_paid },
  { label: 'Reached Disbursement', get: (r) => r.disbursement },
  { label: 'Lost', get: (r) => r.lost },
  { label: 'Lead to Login %', get: (r) => conversionRates(r).leadToLogin },
  { label: 'Login to Sanction %', get: (r) => conversionRates(r).loginToSanction },
  { label: 'Sanction to PF %', get: (r) => conversionRates(r).sanctionToPf },
  { label: 'Lead to Disbursement %', get: (r) => conversionRates(r).leadToDisbursement },
  { label: 'Deals created', get: (r) => r.deals_created },
  { label: 'Sanctioned amount', get: (r) => r.sanctioned_amount },
  { label: 'Disbursed amount', get: (r) => r.disbursed_amount },
  { label: 'Avg days since activity', get: (r) => r.avg_age_days },
];

/** BD lead rows carry the consultancy too — without it "which of my partners
 *  did this come from" is unanswerable from the export. */
const BD_LEAD_COLUMNS = [
  { label: 'Student', get: (r) => r.student_name },
  { label: 'Phone', get: (r) => r.student_phone },
  { label: 'Email', get: (r) => r.student_email },
  { label: 'Consultancy', get: (r) => r.consultancy },
  { label: 'Stage', get: (r) => r.stage },
  { label: 'Assigned RM', get: (r) => r.assigned_rm || 'Unassigned' },
  { label: 'Loan amount', get: (r) => r.loan_amount },
  { label: 'Created', get: (r) => r.created_on },
  { label: 'Last activity', get: (r) => r.last_activity },
  { label: 'Days idle', get: (r) => r.days_idle },
];

async function openBdDetail(row) {
  document.getElementById('repOverlay').hidden = false;
  const name = bdLabel(row);

  document.getElementById('repDrawerName').textContent = name;
  const c = conversionRates(row);
  document.getElementById('repDrawerSub').textContent =
    `${n(row.total_leads)} leads across ${n(row.consultancies)} consultancies · `
    + `${pct(c.leadToLogin)} reach Login · ${pct(c.leadToDisbursement)} reach Disbursement`;

  document.getElementById('repDrawerBody').innerHTML = `
    <div class="funnel-row" style="margin-bottom:18px;">
      ${[['Leads', row.total_leads], ['Login', row.login], ['Sanction', row.sanction],
         ['PF Paid', row.pf_paid], ['Disbursement', row.disbursement], ['Lost', row.lost]]
        .map(([label, v]) => `<div class="funnel-card"><span class="count">${n(v)}</span><span class="label">${label}</span></div>`).join('')}
    </div>
    <div class="report-kv">
      <div><span>Consultancies</span><strong>${n(row.consultancies)}</strong></div>
      <div><span>Login → Sanction</span><strong>${pct(c.loginToSanction)}</strong></div>
      <div><span>Sanction → PF</span><strong>${pct(c.sanctionToPf)}</strong></div>
      <div><span>PF → Disbursement</span><strong>${pct(c.pfToDisbursement)}</strong></div>
      <div><span>Deals created</span><strong>${n(row.deals_created)}</strong></div>
      <div><span>Sanctioned</span><strong>${money(row.sanctioned_amount)}</strong></div>
      <div><span>Disbursed</span><strong>${money(row.disbursed_amount)}</strong></div>
      <div><span>Avg days since activity</span><strong>${row.avg_age_days ?? '–'}d</strong></div>
    </div>
    <div style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap;">
      <button class="btn btn-primary" id="bdExportReport" disabled><i class="fa-solid fa-file-lines"></i> Share report (dashboard + leads)</button>
      <button class="btn btn-ghost" id="bdExportLeads" disabled><i class="fa-solid fa-download"></i> Export leads (CSV)</button>
    </div>
    <h3 style="margin:18px 0 8px;">Leads</h3>
    <div id="bdLeads"><div class="spinner-block"><span class="spinner"></span><span>Loading leads…</span></div></div>
  `;

  // Same shape as openDetail: wired against a mutable array BEFORE the fetch,
  // so a failed load leaves a disabled button rather than a dead live one.
  let leads = [];
  const btnReport = document.getElementById('bdExportReport');
  const btnCsv = document.getElementById('bdExportLeads');

  btnCsv.addEventListener('click', () => {
    downloadCsv(toCsv(leads, BD_LEAD_COLUMNS), `${slug(name)}-bd-leads.csv`);
    showToast(`Exported ${leads.length} leads`);
  });
  btnReport.addEventListener('click', () => {
    const html = buildPartnerReportHtml(row, leads, {
      title: `${name} — BD book`,
      from: state.from, to: state.to, basis: REPORT_DATE_FIELDS[state.dateField],
      generatedOn: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    });
    downloadText(html, `${slug(name)}-bd-report.html`);
    showToast('Report downloaded — open it in a browser or send it on');
  });

  try {
    leads = await getBdLeads(row, state.from, state.to, state.dateField);
  } catch (err) {
    console.error('bd lead detail failed', err);
    document.getElementById('bdLeads').innerHTML =
      `<p class="empty-state">Could not load the lead list.<br>
       <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span></p>`;
    btnReport.disabled = false;
    return;
  }
  btnReport.disabled = false;
  btnCsv.disabled = false;

  document.getElementById('bdLeads').innerHTML = leads.length
    ? `<div style="overflow-x:auto;"><table class="lead-table"><thead><tr>
         <th>Student</th><th>Consultancy</th><th>Stage</th><th>RM</th><th class="num">Days idle</th></tr></thead><tbody>
         ${leads.map((l) => `<tr>
           <td><div class="student-name">${escapeHtml(l.student_name)}</div>
               <div class="student-phone">${escapeHtml(l.student_phone || '')}</div></td>
           <td>${escapeHtml(l.consultancy || '–')}</td>
           <td><span class="badge badge-accent">${escapeHtml(l.stage)}</span></td>
           <td>${escapeHtml(l.assigned_rm || 'Unassigned')}</td>
           <td class="num">${l.days_idle ?? '–'}</td>
         </tr>`).join('')}
       </tbody></table></div>`
    : '<p class="empty-state">No leads in this date range.</p>';
}

function closeDetail() {
  document.getElementById('repOverlay').hidden = true;
}

async function loadBd() {
  const body = document.getElementById('bdBody');
  body.innerHTML = '<tr><td colspan="12"><div class="spinner-block"><span class="spinner"></span><span>Loading report…</span></div></td></tr>';
  try {
    state.bdRows = await getBdReport(state.from, state.to, state.dateField);
    populateBdDropdown();
    renderBd();
  } catch (err) {
    console.error('bd report failed', err);
    body.innerHTML = `<tr><td colspan="12" class="empty-state">
      Could not load the report.<br>
      <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span>
    </td></tr>`;
  }
}

/** Loads whichever tab is showing. The two reports are separate RPCs, so the
 *  inactive one is not fetched until you switch to it. */
function loadActive() {
  return state.tab === 'bd' ? loadBd() : load();
}

/**
 * Switches tab. Both tabs share the date filters (they are the same question
 * asked of the same leads), so switching re-runs the load with whatever is
 * already in the filter bar rather than resetting it.
 */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.report-tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.getElementById('cardConsultancy').hidden = tab !== 'consultancy';
  document.getElementById('cardBd').hidden = tab !== 'bd';
  document.getElementById('fieldConsultancy').hidden = tab !== 'consultancy';
  document.getElementById('fieldBd').hidden = tab !== 'bd';
  document.getElementById('repSubtitle').textContent = tab === 'bd'
    ? 'Per-BD-manager funnel, conversion and ageing across the consultancies they own.'
    : 'Per-consultancy funnel, conversion and ageing — ready to share.';
  loadActive();
}

async function load() {
  const body = document.getElementById('repBody');
  body.innerHTML = '<tr><td colspan="11"><div class="spinner-block"><span class="spinner"></span><span>Loading report…</span></div></td></tr>';
  try {
    state.rows = await getConsultancyReport(state.from, state.to, state.dateField);
    populateConsultancyDropdown();
    render();
  } catch (err) {
    // Surface the real reason. "Please refresh" taught us nothing when this
    // page sat on its spinner — the actual cause was a PostgREST 404 because
    // the schema cache had not picked the new function up yet.
    console.error('consultancy report failed', err);
    body.innerHTML = `<tr><td colspan="11" class="empty-state">
      Could not load the report.<br>
      <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span>
    </td></tr>`;
  }
}

async function bootstrap() {
  const user = await getCurrentUser();
  document.getElementById('userName').textContent = user.full_name;
  document.getElementById('userRole').textContent = user.role;
  document.getElementById('avatar').textContent = (user.full_name || '?').charAt(0).toUpperCase();
  mountTopbar({ app: 'manager-dashboard', user });

  // Said plainly rather than buried: disbursed value is near-zero across the
  // board because the imported book has stage labels with no lender deal
  // behind them, and ageing is measured from the import date for anything
  // untouched since. Better to state it than let someone quote a wrong number.
  document.getElementById('dataNote').innerHTML =
    '<i class="fa-solid fa-circle-info"></i> <span>Funnel counts are by <strong>current</strong> stage — a lead that reached Login and was later lost counts only under Lost, because the imported book carries no stage history. <strong>Sanctioned and disbursed amounts are near-zero</strong> until lender deals exist for the imported leads. Ageing is measured from last activity, which for untouched imported leads is the 30 July import date.</span>';

  const renderActive = () => (state.tab === 'bd' ? renderBd() : render());

  document.querySelectorAll('.report-tab').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  });
  wireSorting('repTable', 'consultancy', render);
  wireSorting('bdTable', 'bd', renderBd);

  document.getElementById('repDateField').addEventListener('change', (e) => { state.dateField = e.target.value; loadActive(); });
  document.getElementById('repFrom').addEventListener('change', (e) => { state.from = e.target.value; loadActive(); });
  document.getElementById('repTo').addEventListener('change', (e) => { state.to = e.target.value; loadActive(); });
  document.getElementById('repConsultancy').addEventListener('change', (e) => { state.consultancy = e.target.value; render(); });
  document.getElementById('repBd').addEventListener('change', (e) => { state.bd = e.target.value; renderBd(); });
  document.getElementById('repMin').addEventListener('input', (e) => { state.min = Number(e.target.value) || 0; renderActive(); });
  document.getElementById('repClear').addEventListener('click', () => {
    state.from = ''; state.to = ''; state.consultancy = ''; state.bd = ''; state.min = 0; state.dateField = 'created_at';
    document.getElementById('repDateField').value = 'created_at';
    document.getElementById('repFrom').value = '';
    document.getElementById('repTo').value = '';
    document.getElementById('repConsultancy').value = '';
    document.getElementById('repBd').value = '';
    document.getElementById('repMin').value = '0';
    loadActive();
  });
  document.getElementById('repExportAll').addEventListener('click', () => {
    if (state.tab === 'bd') {
      const rows = visibleBdRows();
      downloadCsv(toCsv(rows, BD_SUMMARY_COLUMNS), 'bd-manager-report.csv');
      showToast(`Exported ${rows.length} BD managers`);
      return;
    }
    const rows = visibleRows();
    downloadCsv(toCsv(rows, SUMMARY_COLUMNS), 'consultancy-report.csv');
    showToast(`Exported ${rows.length} consultancies`);
  });
  document.getElementById('repDrawerClose').addEventListener('click', closeDetail);
  // Only a click on the scrim itself closes. Without the target check every
  // click that bubbles up from inside the drawer — including the export
  // buttons — would close it instead of doing its job.
  document.getElementById('repOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDetail();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  await load();
}

// guardBootstrap catches a bootstrap that THROWS. It cannot catch one that
// simply never settles — an auth call that hangs leaves the page sitting on
// its spinner with nothing in the console, which is exactly how this page
// looked when PostgREST had not yet reloaded its schema cache. This turns a
// silent hang into something with a next step.
let started = false;
const watchdog = setTimeout(() => {
  if (started) return;
  const body = document.getElementById('repBody');
  if (body && body.textContent.includes('Loading')) {
    body.innerHTML = `<tr><td colspan="11" class="empty-state">
      Still loading after 15 seconds — something is not responding.<br>
      <span style="font-size:12px;">Check the browser console for the failing request, then reload.</span>
    </td></tr>`;
  }
}, 15000);

guardBootstrap(async () => {
  await bootstrap();
  started = true;
  clearTimeout(watchdog);
}, 'Partner Reports');
