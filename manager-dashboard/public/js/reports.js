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
  getConsultancyReport, getConsultancyLeads, conversionRates, toCsv,
} from './services/consultancyReportService.js';

const state = { rows: [], from: '', to: '', consultancy: '', min: 0 };

const n = (v) => Number(v || 0).toLocaleString('en-IN');
const pct = (v) => (v === null ? '–' : `${v}%`);

/** Money, but only when there is any — a column of "₹0" reads as a bug. */
function money(v) {
  const num = Number(v || 0);
  if (!num) return '–';
  return `₹${num.toLocaleString('en-IN')}`;
}

function visibleRows() {
  return state.rows.filter((r) =>
    (r.total_leads >= state.min) &&
    (!state.consultancy || r.consultancy_name === state.consultancy));
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

function render() {
  const body = document.getElementById('repBody');
  const rows = visibleRows();

  document.getElementById('repCount').innerHTML =
    `<strong>${n(rows.length)}</strong> ${rows.length === 1 ? 'consultancy' : 'consultancies'}`
    + `<span class="lead-count-filters"> · ${n(rows.reduce((s, r) => s + Number(r.total_leads), 0))} leads`
    + (state.from || state.to ? ` · created ${state.from || '…'} → ${state.to || '…'}` : '')
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
  const drawer = document.getElementById('repDrawer');
  const overlay = document.getElementById('repOverlay');
  drawer.hidden = false; overlay.hidden = false;

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
    <div style="display:flex;gap:8px;margin:16px 0;">
      <button class="btn btn-primary" id="repExportLeads"><i class="fa-solid fa-download"></i> Export these leads</button>
    </div>
    <h3 style="margin:18px 0 8px;">Leads</h3>
    <div id="repLeads"><div class="spinner-block"><span class="spinner"></span><span>Loading leads…</span></div></div>
  `;

  let leads = [];
  try {
    leads = await getConsultancyLeads(row, state.from, state.to);
  } catch (err) {
    console.error('consultancy lead detail failed', err);
    document.getElementById('repLeads').innerHTML =
      '<p class="empty-state">Could not load the lead list.</p>';
    return;
  }

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

function closeDetail() {
  document.getElementById('repDrawer').hidden = true;
  document.getElementById('repOverlay').hidden = true;
}

async function load() {
  const body = document.getElementById('repBody');
  body.innerHTML = '<tr><td colspan="11"><div class="spinner-block"><span class="spinner"></span><span>Loading report…</span></div></td></tr>';
  try {
    state.rows = await getConsultancyReport(state.from, state.to);
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

  document.getElementById('repFrom').addEventListener('change', (e) => { state.from = e.target.value; load(); });
  document.getElementById('repTo').addEventListener('change', (e) => { state.to = e.target.value; load(); });
  document.getElementById('repConsultancy').addEventListener('change', (e) => { state.consultancy = e.target.value; render(); });
  document.getElementById('repMin').addEventListener('input', (e) => { state.min = Number(e.target.value) || 0; render(); });
  document.getElementById('repClear').addEventListener('click', () => {
    state.from = ''; state.to = ''; state.consultancy = ''; state.min = 0;
    document.getElementById('repFrom').value = '';
    document.getElementById('repTo').value = '';
    document.getElementById('repConsultancy').value = '';
    document.getElementById('repMin').value = '0';
    load();
  });
  document.getElementById('repExportAll').addEventListener('click', () => {
    const rows = visibleRows();
    downloadCsv(toCsv(rows, SUMMARY_COLUMNS), 'consultancy-report.csv');
    showToast(`Exported ${rows.length} consultancies`);
  });
  document.getElementById('repDrawerClose').addEventListener('click', closeDetail);
  document.getElementById('repOverlay').addEventListener('click', closeDetail);
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
