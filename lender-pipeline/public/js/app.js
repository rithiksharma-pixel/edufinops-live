import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { guardDestination, applyNavPermissions } from '../../../shared/js/roleAccess.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import {
  getPipeline, getDealDetail, getDealStages, getDealHoldReasons, getDealRejectionReasons,
  updateStageDetails, changeDealStage, putDealOnHold, releaseDealHold, rejectDeal, reinstateDeal,
  recordDisbursement, getMessages, sendMessage, STAGE_TABLE_MAP,
  getMyLenderProfile, updateMyLenderProfile,
  getLeadProfileForLender, getDocumentDownloadUrl,
} from './services/lenderDealService.js';
import { getQueryCategories, getQueriesForDeal, raiseQuery, resolveQuery } from './services/dealQueryService.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';

let currentUser;
function formatCurrency(amount) {
  if (!amount) return '–';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}
function formatDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '–'; }
function formatDateTime(d) { return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'; }

/** ₹ in lakh / crore, the way the team and the banks talk about it. */
function compactInr(n) {
  if (!n) return '–';
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');

// =========================================================
// Pipeline view state. The institution's whole list is loaded once (a bank
// sees at most a few hundred cases) and every tab, stage chip and search is
// a filter over it — instant, and the counts on the tabs always agree with
// the rows underneath them.
// =========================================================
const OPEN_STAGE_ORDER = ['Bank Prospect', 'Login', 'Sanction', 'PF Paid', 'Disbursement'];
const PAGE = 100;

const pipe = { rows: [], tab: 'action', stage: '', search: '', shown: PAGE };

const isClosed = (r) => r.is_terminal || r.is_rejected;
const isPastTat = (r) => !isClosed(r) && r.tat_days != null && r.days_at_stage > r.tat_days;
const needsAction = (r) => !isClosed(r) && (isPastTat(r) || r.open_queries > 0 || r.is_on_hold);

const TABS = [
  { id: 'action', label: 'Needs action', alert: true, test: needsAction,
    hint: 'Past the turnaround time for their stage, on hold, or carrying an open query. Longest overdue first.' },
  { id: 'live', label: 'All live', test: (r) => !isClosed(r),
    hint: 'Every open case, longest at its current stage first.' },
  { id: 'mine', label: 'Assigned to me', test: (r) => r.assigned_to_me && !isClosed(r),
    hint: 'Open cases assigned to you personally.' },
  { id: 'closed', label: 'Closed', test: isClosed,
    hint: 'Closed won, declined or rejected. Most recent first.' },
];

/** How overdue a case is, relative to its own stage's TAT. */
const overdueRatio = (r) => (r.tat_days ? r.days_at_stage / r.tat_days : r.days_at_stage / 30);

function currentTab() { return TABS.find((t) => t.id === pipe.tab) || TABS[0]; }

function visibleRows() {
  const q = pipe.search.toLowerCase();
  return pipe.rows
    .filter(currentTab().test)
    .filter((r) => !pipe.stage || r.stage_name === pipe.stage)
    .filter((r) => !q || [r.student_name, r.course_name, r.university_name].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (pipe.tab === 'closed'
      ? new Date(b.stage_since) - new Date(a.stage_since)
      : overdueRatio(b) - overdueRatio(a)));
}

function stageChip(r) {
  let tone = 'accent';
  if (r.stage_name === 'Closed Won') tone = 'good';
  else if (r.is_terminal) tone = 'bad';
  let html = `<span class="pp-chip ${tone}">${escapeHtml(r.stage_name)}</span>`;
  if (r.is_rejected) html += '<span class="pp-chip bad">Rejected</span>';
  else if (r.is_on_hold) html += '<span class="pp-chip warn">On hold</span>';
  return html;
}

function stageMeter(r) {
  if (isClosed(r)) return '<span class="pp-muted">–</span>';
  const tat = r.tat_days;
  const tone = tat == null ? '' : r.days_at_stage > tat ? 'bad' : r.days_at_stage > tat * 0.7 ? 'warn' : '';
  const width = Math.min(100, (r.days_at_stage / Math.max(tat || 30, 1)) * 100);
  const title = tat == null ? 'No turnaround time set for this stage' : `Turnaround time for ${r.stage_name}: ${tat} days`;
  return `<span class="pp-meter ${tone}" title="${escapeHtml(title)}">
    <span class="pp-meter-track"><span class="pp-meter-fill" style="width:${Math.max(4, width)}%"></span></span>
    <span class="pp-meter-text">${r.days_at_stage}d${tat != null ? ` <span class="pp-muted">/ ${tat}</span>` : ''}</span>
  </span>`;
}

function renderStats() {
  const live = pipe.rows.filter((r) => !isClosed(r));
  const past = live.filter(isPastTat);
  const oldest = past.reduce((m, r) => Math.max(m, r.days_at_stage), 0);
  const sanctioned = pipe.rows.filter((r) => Number(r.sanction_amount) > 0 && !r.is_rejected);
  const sanctionValue = sanctioned.reduce((s, r) => s + Number(r.sanction_amount), 0);
  const disbursed = pipe.rows.reduce((s, r) => s + Number(r.total_disbursed_amount || 0), 0);
  const disbursedCount = pipe.rows.filter((r) => Number(r.total_disbursed_amount) > 0).length;

  const stat = (label, value, sub, tone = '') => `<div class="pp-stat ${tone}"><div class="pp-stat-label">${label}</div><div class="pp-stat-value">${value}</div>${sub ? `<div class="pp-stat-sub">${sub}</div>` : ''}</div>`;
  document.getElementById('lpStats').innerHTML = [
    stat('Live cases', fmtInt(live.length), `${fmtInt(pipe.rows.length - live.length)} closed`),
    stat('Past turnaround time', fmtInt(past.length), past.length ? `Longest ${oldest} days at one stage` : 'Nothing overdue', past.length ? 'warn' : 'good'),
    stat('Sanctioned', compactInr(sanctionValue), `${fmtInt(sanctioned.length)} cases`),
    stat('Disbursed', compactInr(disbursed), `${fmtInt(disbursedCount)} cases`, disbursed ? 'good' : ''),
  ].join('');
}

function renderStages() {
  const base = pipe.rows.filter(currentTab().test);
  const counts = {};
  base.forEach((r) => { counts[r.stage_name] = (counts[r.stage_name] || 0) + 1; });
  const names = [...OPEN_STAGE_ORDER, ...Object.keys(counts).filter((n) => !OPEN_STAGE_ORDER.includes(n))]
    .filter((n) => counts[n]);
  if (pipe.stage && !counts[pipe.stage]) pipe.stage = '';
  const el = document.getElementById('lpStages');
  el.innerHTML = `<button class="pp-stage ${pipe.stage ? '' : 'on'}" data-stage="">All stages <b>${fmtInt(base.length)}</b></button>` +
    names.map((n) => `<button class="pp-stage ${pipe.stage === n ? 'on' : ''}" data-stage="${escapeHtml(n)}">${escapeHtml(n)} <b>${fmtInt(counts[n])}</b></button>`).join('');
  el.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => {
    pipe.stage = b.dataset.stage; pipe.shown = PAGE; renderPipeline();
  }));
}

function renderTabs() {
  const el = document.getElementById('lpTabs');
  el.innerHTML = TABS.map((t) => {
    const n = pipe.rows.filter(t.test).length;
    return `<button class="pp-tab ${t.id === pipe.tab ? 'on' : ''} ${t.alert && n ? 'alert' : ''}" role="tab" aria-selected="${t.id === pipe.tab}" data-tab-id="${t.id}">${t.label} <span class="n">${fmtInt(n)}</span></button>`;
  }).join('');
  el.querySelectorAll('[data-tab-id]').forEach((b) => b.addEventListener('click', () => {
    pipe.tab = b.dataset.tabId; pipe.shown = PAGE; renderPipeline();
  }));
  document.getElementById('lpHint').textContent = currentTab().hint;
}

function renderRows() {
  const tbody = document.getElementById('dealsBody');
  const more = document.getElementById('lpMore');
  const rows = visibleRows();
  if (rows.length === 0) {
    const empty = pipe.rows.length === 0
      ? emptyState('fa-building-columns', 'No cases yet', 'Cases Zolve Tangent shares with your institution will show up here.')
      : emptyState('fa-circle-check', 'Nothing here', pipe.search || pipe.stage ? 'Try clearing the search or stage filter.' : 'No cases match this view right now.');
    tbody.innerHTML = `<tr><td colspan="6">${empty}</td></tr>`;
    more.hidden = true;
    return;
  }
  tbody.innerHTML = rows.slice(0, pipe.shown).map((r) => `
    <tr data-id="${r.deal_id}">
      <td><div class="pp-name">${escapeHtml(r.student_name || '–')}</div><div class="pp-sub">${escapeHtml([r.course_name, r.university_name].filter(Boolean).join(' · ') || 'No course recorded')}</div></td>
      <td>${stageChip(r)}</td>
      <td>${stageMeter(r)}</td>
      <td class="r pp-num">${compactInr(r.loan_amount_requested)}</td>
      <td class="r pp-num">${compactInr(r.sanction_amount)}</td>
      <td class="r">${r.open_queries ? `<span class="pp-chip warn">${r.open_queries} open</span>` : '<span class="pp-muted">–</span>'}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDrawer(tr.dataset.id)));

  more.hidden = false;
  more.innerHTML = rows.length > pipe.shown
    ? `<span>Showing ${fmtInt(pipe.shown)} of ${fmtInt(rows.length)}</span><button class="btn btn-ghost" id="btnShowMore">Show ${fmtInt(Math.min(PAGE, rows.length - pipe.shown))} more</button>`
    : `<span>${fmtInt(rows.length)} case${rows.length === 1 ? '' : 's'}</span><span></span>`;
  document.getElementById('btnShowMore')?.addEventListener('click', () => { pipe.shown += PAGE; renderRows(); });
}

function renderPipeline() {
  renderTabs();
  renderStages();
  renderRows();
}

async function refreshDealsList() {
  pipe.rows = await getPipeline();
  renderStats();
  renderPipeline();
}

function exportView() {
  const rows = visibleRows();
  const cols = [
    ['Student', (r) => r.student_name], ['Course', (r) => r.course_name], ['University', (r) => r.university_name],
    ['Country', (r) => r.destination_country], ['Stage', (r) => r.stage_name],
    ['Status', (r) => (r.is_rejected ? 'Rejected' : r.is_on_hold ? 'On hold' : '')],
    ['Days at stage', (r) => r.days_at_stage], ['Stage TAT (days)', (r) => r.tat_days],
    ['Requested', (r) => r.loan_amount_requested], ['Sanctioned', (r) => r.sanction_amount],
    ['Disbursed', (r) => r.total_disbursed_amount], ['Open queries', (r) => r.open_queries],
  ];
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipeline-${currentTab().id}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function openDrawer(dealId) {
  document.getElementById('drawerOverlay').hidden = false;
  const stages = await getDealStages();
  const holdReasons = await getDealHoldReasons();
  const rejectionReasons = await getDealRejectionReasons();
  await loadManagePanel(dealId, stages, holdReasons, rejectionReasons);
  await renderProfile(dealId);
  await renderQueries(dealId);
  await renderMessages(dealId);
}

function fieldRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="detail-row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(String(value))}</span></div>`;
}

async function renderProfile(dealId) {
  const panel = document.getElementById('panelProfile');
  panel.innerHTML = emptyState('fa-spinner fa-spin', 'Loading student profile…');
  let profile;
  try {
    profile = await getLeadProfileForLender(dealId);
  } catch (err) {
    panel.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load the student profile', 'Try reopening this case, or check back in a moment.');
    return;
  }
  const lead = profile.lead || {};
  const academic = profile.academic || {};
  const parents = profile.parents || {};

  const universityHtml = (profile.university_choices || []).length
    ? profile.university_choices.map((u) => `<div class="detail-row"><span class="k">Choice ${u.sequence_order}</span><span class="v">${escapeHtml(u.university_name)}</span></div>`).join('')
    : '<p class="empty-state" style="padding:6px 0;">No university choices recorded.</p>';

  const coApplicantsHtml = (profile.co_applicants || []).length
    ? profile.co_applicants.map((c) => `
        <div class="lender-app-card">
          <div class="lender-name">${escapeHtml(c.full_name)} <span style="color:var(--ink-500);font-weight:400;">(${escapeHtml(c.relationship_to_student || '–')})</span></div>
          ${fieldRow('Annual income', c.annual_income ? formatCurrency(c.annual_income) : null)}
          ${fieldRow('Employer', c.employer_name)}
          ${fieldRow('Designation', c.designation)}
          ${fieldRow('Monthly net income', c.monthly_net_income ? formatCurrency(c.monthly_net_income) : null)}
          ${fieldRow('Credit score', c.credit_score)}
        </div>`).join('')
    : '<p class="empty-state" style="padding:6px 0;">No co-applicant added.</p>';

  const collateralHtml = (profile.collateral || []).length
    ? profile.collateral.map((c) => `
        <div class="lender-app-card">
          ${fieldRow('Security offered', c.security_offered)}
          ${fieldRow('Type', c.security_type)}
          ${fieldRow('Current value', c.current_value ? formatCurrency(c.current_value) : null)}
          ${fieldRow('Owned by', c.owned_by)}
        </div>`).join('')
    : '';

  const referencesHtml = (profile.references || []).length
    ? profile.references.map((r) => `
        <div class="lender-app-card">
          <div class="lender-name">${escapeHtml([r.first_name, r.last_name].filter(Boolean).join(' ') || 'Reference')} <span style="color:var(--ink-500);font-weight:400;">(${escapeHtml(r.reference_type || '–')})</span></div>
          ${fieldRow('Phone', r.phone)}
          ${fieldRow('Email', r.email)}
          ${fieldRow('Address', r.address)}
        </div>`).join('')
    : '<p class="empty-state" style="padding:6px 0;">No references recorded.</p>';

  const parentsHtml = (parents.father_first_name || parents.mother_first_name)
    ? `${fieldRow('Father', [parents.father_first_name, parents.father_last_name].filter(Boolean).join(' '))}
       ${fieldRow('Father mobile', parents.father_mobile)}
       ${fieldRow('Mother', [parents.mother_first_name, parents.mother_last_name].filter(Boolean).join(' '))}
       ${fieldRow('Mother mobile', parents.mother_mobile)}`
    : '<p class="empty-state" style="padding:6px 0;">No parent details recorded.</p>';

  const documentsHtml = (profile.documents || []).length
    ? profile.documents.map((d) => `
        <div class="detail-row">
          <span class="k">${escapeHtml(d.document_type || d.file_name)}</span>
          <span class="v">
            <span class="badge ${d.verification_status === 'Verified' ? '' : d.verification_status === 'Rejected' ? 'badge-danger' : 'badge-warning'}">${escapeHtml(d.verification_status)}</span>
            <button class="btn btn-ghost" style="margin-left:8px;font-size:11px;padding:3px 9px;" data-download="${escapeHtml(d.storage_path)}">Download</button>
          </span>
        </div>`).join('')
    : '<p class="empty-state" style="padding:6px 0;">No documents uploaded yet.</p>';

  panel.innerHTML = `
    <h4 style="font-size:13px;font-weight:500;margin:0 0 8px;">Applicant</h4>
    ${fieldRow('Phone', lead.student_phone)}
    ${fieldRow('Email', lead.student_email)}
    ${fieldRow('Date of birth', lead.student_dob ? formatDate(lead.student_dob) : null)}
    ${fieldRow('Gender', lead.gender)}
    ${fieldRow('Marital status', lead.marital_status)}
    ${fieldRow('Citizenship', lead.citizenship)}
    ${fieldRow('PAN', lead.pan_number)}
    ${fieldRow('Aadhaar', lead.aadhaar_number)}
    ${fieldRow('Passport', lead.passport_number)}
    ${fieldRow('Current address', [lead.current_address, lead.current_city, lead.current_state, lead.current_pincode].filter(Boolean).join(', '))}
    ${fieldRow('Permanent address', [lead.permanent_address, lead.permanent_city, lead.permanent_state, lead.permanent_pincode].filter(Boolean).join(', '))}
    ${fieldRow('Relationship manager', lead.assigned_rm_name)}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Course &amp; loan</h4>
    ${fieldRow('Course', lead.course_name)}
    ${fieldRow('Degree', lead.degree)}
    ${fieldRow('Destination', lead.destination_country)}
    ${fieldRow('Intake', lead.intake_month && lead.intake_year ? `${lead.intake_month}/${lead.intake_year}` : null)}
    ${fieldRow('Admission offer', lead.admission_offer_status)}
    ${fieldRow('Loan type', lead.loan_type)}
    ${fieldRow('Loan amount requested', formatCurrency(lead.loan_amount_requested))}
    ${fieldRow('Total study cost', lead.total_study_cost ? formatCurrency(lead.total_study_cost) : null)}
    ${fieldRow('Self funds available', lead.self_funds_available ? formatCurrency(lead.self_funds_available) : null)}
    <h4 style="font-size:13px;font-weight:500;margin:14px 0 8px;">University choices</h4>
    ${universityHtml}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Academic</h4>
    ${fieldRow('Highest qualification', academic.highest_qualification)}
    ${fieldRow('English test taken', academic.english_test_taken)}
    ${fieldRow('Aptitude test taken', academic.aptitude_test_taken)}
    ${fieldRow('UG college', academic.ug_college_name)}
    ${fieldRow('UG course', academic.ug_course_name)}
    ${fieldRow('UG CGPA', academic.ug_cgpa)}
    ${fieldRow('UG graduation year', academic.ug_graduation_year)}
    ${fieldRow('UG backlogs', academic.ug_backlogs)}
    ${fieldRow('PG college', academic.pg_college_name)}
    ${fieldRow('PG course', academic.pg_course_name)}
    ${fieldRow('PG CGPA', academic.pg_cgpa)}
    ${fieldRow('Scholarship offered', academic.scholarship_offered ? `Yes${academic.scholarship_amount ? ' · ' + formatCurrency(academic.scholarship_amount) : ''}` : null)}
    ${Object.keys(academic).length === 0 ? '<p class="empty-state" style="padding:6px 0;">No academic details recorded.</p>' : ''}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Family</h4>
    ${parentsHtml}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Financial</h4>
    ${fieldRow('Employment status', lead.employment_status)}
    ${fieldRow('Applicant financial status', lead.applicant_financial_status)}
    ${fieldRow('Co-applicant financial status', lead.coapplicant_financial_status)}
    ${fieldRow('Credit score', lead.credit_score)}
    ${fieldRow('Savings amount', lead.savings_amount ? formatCurrency(lead.savings_amount) : null)}
    ${fieldRow('Has liabilities', lead.has_liabilities === true ? `Yes${lead.liabilities_amount ? ' · ' + formatCurrency(lead.liabilities_amount) : ''}` : lead.has_liabilities === false ? 'No' : null)}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Co-applicants</h4>
    ${coApplicantsHtml}

    ${collateralHtml ? `<h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Collateral</h4>${collateralHtml}` : ''}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">References</h4>
    ${referencesHtml}

    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Documents</h4>
    ${documentsHtml}
  `;

  panel.querySelectorAll('[data-download]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const url = await getDocumentDownloadUrl(btn.dataset.download);
        window.open(url, '_blank');
      } catch (err) {
        showToast('Could not open this document.', true);
      }
    });
  });
}

async function renderQueries(dealId) {
  const panel = document.getElementById('panelQueries');
  const [queries, categories] = await Promise.all([getQueriesForDeal(dealId), getQueryCategories()]);
  const openCount = queries.filter((q) => q.status === 'Open').length;
  const categoryOptions = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  const queryRows = queries.length === 0
    ? '<p class="empty-state">No queries raised yet.</p>'
    : queries.map((q) => `
      <div class="lender-app-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div class="lender-name">${escapeHtml(q.deal_query_categories?.name || 'Query')}</div>
            <div style="font-size:11px;color:var(--ink-500);margin-top:2px;">${escapeHtml(q.raised_by_user?.full_name || 'Someone')} · ${formatDateTime(q.created_at)}</div>
          </div>
          <span class="badge ${q.status === 'Resolved' ? '' : 'badge-warning'}">${escapeHtml(q.status)}</span>
        </div>
        <div style="font-size:13px;margin-top:6px;">${escapeHtml(q.question)}</div>
        ${q.status === 'Resolved'
          ? `<div class="detail-row"><span class="k">Resolution</span><span class="v">${escapeHtml(q.resolution || '–')}</span></div>`
          : `<div style="margin-top:8px;"><textarea data-resolve-input="${q.id}" rows="2" placeholder="Resolution…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;"></textarea><button class="btn btn-ghost" style="margin-top:6px;" data-resolve="${q.id}">Mark resolved</button></div>`}
      </div>`).join('');

  panel.innerHTML = `
    <h4 style="font-size:13px;font-weight:500;margin:0 0 8px;">Queries${openCount ? ` <span class="badge badge-warning">${openCount} open</span>` : ''}</h4>
    ${queryRows}
    <div style="margin-top:14px;">
      <div class="form-field"><label>Raise a query</label><select id="newQueryCategory">${categoryOptions}</select></div>
      <textarea id="newQueryQuestion" rows="2" placeholder="What's the question?" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;margin-top:6px;"></textarea>
      <button class="btn btn-ghost" style="margin-top:6px;" id="btnRaiseQuery">Raise query</button>
    </div>
  `;

  document.getElementById('btnRaiseQuery').addEventListener('click', async () => {
    const categoryId = document.getElementById('newQueryCategory').value;
    const question = document.getElementById('newQueryQuestion').value.trim();
    if (!question) { showToast('Enter the question to raise.', true); return; }
    try {
      await raiseQuery(dealId, categoryId, question, currentUser.id);
      showToast('Query raised.');
      await renderQueries(dealId);
    } catch (err) {
      showToast('Could not raise this query.', true);
    }
  });

  panel.querySelectorAll('[data-resolve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const queryId = btn.dataset.resolve;
      const resolution = panel.querySelector(`[data-resolve-input="${queryId}"]`).value.trim();
      if (!resolution) { showToast('Enter a resolution before marking this resolved.', true); return; }
      try {
        await resolveQuery(queryId, resolution, currentUser.id);
        showToast('Query resolved.');
        await renderQueries(dealId);
      } catch (err) {
        showToast('Could not resolve this query.', true);
      }
    });
  });
}

async function loadManagePanel(dealId, stages, holdReasons, rejectionReasons) {
  const { deal, stageDetails, disbursements } = await getDealDetail(dealId);
  document.getElementById('drawerName').textContent = deal.leads?.student_name || '–';
  document.getElementById('drawerSubtitle').textContent = [deal.leads?.course_name, deal.leads?.university_name].filter(Boolean).join(' · ') || '–';

  const panel = document.getElementById('panelManage');
  const stageName = deal.current_deal_stage?.name;

  if (deal.is_rejected) {
    panel.innerHTML = `
      <div class="detail-row"><span class="k">Rejected at stage</span><span class="v">${escapeHtml(stageName || '–')}</span></div>
      <div class="detail-row"><span class="k">Remarks</span><span class="v">${escapeHtml(deal.rejection_remarks || '–')}</span></div>
      <button class="btn btn-primary" id="btnReinstate" style="width:100%;margin-top:10px;">Reinstate this case</button>
    `;
    document.getElementById('btnReinstate').addEventListener('click', async () => {
      try { await reinstateDeal(dealId, 'Reinstated by lender'); showToast('Deal reinstated.'); await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); await refreshDealsList(); }
      catch (err) { showToast('Could not reinstate.', true); }
    });
    return;
  }

  const stageConfig = STAGE_TABLE_MAP[stageName];
  const stageFormHtml = stageConfig && stageDetails ? stageConfig.fields.map((f) => {
    const val = stageDetails[f.key] ?? '';
    if (f.type === 'textarea') return `<div class="form-field"><label>${f.label}</label><textarea data-field="${f.key}" rows="2">${escapeHtml(val)}</textarea></div>`;
    return `<div class="form-field"><label>${f.label}</label><input data-field="${f.key}" type="${f.type}" value="${escapeHtml(val)}" /></div>`;
  }).join('') : '';

  // Offer the one real next step plus the exits, not every stage in the
  // table: a bank moving a Login case "back" to Bank Prospect, or skipping to
  // PF Paid, is never what was meant, and the server refuses skips anyway.
  const currentOrder = deal.current_deal_stage?.sequence_order ?? 0;
  const nextStage = stages
    .filter((s) => !s.is_terminal && s.sequence_order > currentOrder)
    .sort((a, b) => a.sequence_order - b.sequence_order)[0];
  const exits = stages.filter((s) => s.is_terminal && s.id !== deal.current_deal_stage_id);
  const stageOptions =
    (nextStage ? `<optgroup label="Next step"><option value="${nextStage.id}">${escapeHtml(nextStage.name)}</option></optgroup>` : '') +
    (exits.length ? `<optgroup label="Close the case">${exits.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</optgroup>` : '');
  const holdOptions = holdReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const rejectOptions = rejectionReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

  let disbursementHtml = '';
  if (stageName === 'Disbursement' || stageName === 'Closed Won') {
    disbursementHtml = `
      <h4 style="font-size:13px;font-weight:500;margin:16px 0 8px;">Tranches</h4>
      ${disbursements.length === 0 ? '<p class="empty-state" style="padding:8px 0;">None recorded yet.</p>' : disbursements.map((d) => `<div class="detail-row"><span class="k">Tranche ${d.tranche_number}</span><span class="v">${formatCurrency(d.amount)} · ${formatDate(d.disbursed_date)}</span></div>`).join('')}
      ${stageName === 'Disbursement' ? `
        <div class="form-grid" style="margin-top:10px;">
          <div class="form-field"><label>Tranche number</label><input type="number" min="1" data-tranche="tranche_number" value="${disbursements.length + 1}" /></div>
          <div class="form-field"><label>Amount</label><input type="number" min="0" data-tranche="amount" /></div>
          <div class="form-field"><label>Disbursed date</label><input type="date" data-tranche="disbursed_date" /></div>
          <div class="form-field"><label>Academic term</label><input type="text" data-tranche="academic_term" /></div>
        </div>
        <button class="btn btn-ghost" style="margin-top:8px;" id="btnAddTranche">Add tranche</button>
      ` : ''}
    `;
  }

  panel.innerHTML = `
    ${stageConfig ? `<h4 style="font-size:13px;font-weight:500;margin:0 0 8px;">${escapeHtml(stageName)} details</h4><div class="form-grid">${stageFormHtml}</div><button class="btn btn-ghost" style="margin-top:8px;" id="btnSaveStageFields">Save details</button>` : ''}
    ${disbursementHtml}
    <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Actions</h4>
    <div class="form-field"><label>Move this case to</label><select id="nextStageSelect"><option value="">Select…</option>${stageOptions}</select></div>
    <button class="btn btn-ghost" id="btnAdvance">Move stage</button>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="btn btn-ghost" style="flex:1;" id="btnToggleHold">${deal.is_on_hold ? 'Release hold' : 'Put on hold'}</button>
      <button class="btn btn-ghost" style="flex:1;color:var(--danger);" id="btnToggleReject">Reject</button>
    </div>
    <div id="holdForm" hidden style="margin-top:10px;">
      <div class="form-field"><label>Reason</label><select id="holdReasonSelect">${holdOptions}</select></div>
      <div class="form-field"><label>Remarks</label><textarea id="holdRemarks" rows="2"></textarea></div>
      <button class="btn btn-primary" id="btnConfirmHold">Confirm hold</button>
    </div>
    <div id="rejectForm" hidden style="margin-top:10px;">
      <div class="form-field"><label>Reason</label><select id="rejectReasonSelect">${rejectOptions}</select></div>
      <div class="form-field"><label>Remarks</label><textarea id="rejectRemarks" rows="2"></textarea></div>
      <button class="btn btn-primary" style="background:var(--danger);" id="btnConfirmReject">Confirm rejection</button>
    </div>
  `;

  if (stageConfig) {
    document.getElementById('btnSaveStageFields').addEventListener('click', async () => {
      const fields = {};
      panel.querySelectorAll('[data-field]').forEach((el) => {
        if (el.closest('#holdForm') || el.closest('#rejectForm')) return;
        fields[el.dataset.field] = el.value || null;
      });
      try { await updateStageDetails(stageName, dealId, fields); showToast('Saved.'); }
      catch (err) { showToast('Could not save.', true); }
    });
  }

  document.getElementById('btnAdvance').addEventListener('click', async () => {
    const val = document.getElementById('nextStageSelect').value;
    if (!val) { showToast('Choose a stage.', true); return; }
    try {
      await changeDealStage(dealId, val);
      showToast('Stage updated.');
      await loadManagePanel(dealId, stages, holdReasons, rejectionReasons);
      await refreshDealsList();
    } catch (err) { showToast(err.message || 'Could not change stage.', true); }
  });

  document.getElementById('btnToggleHold').addEventListener('click', async () => {
    if (deal.is_on_hold) {
      try { await releaseDealHold(dealId); showToast('Hold released.'); await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); await refreshDealsList(); }
      catch (err) { showToast('Could not release.', true); }
      return;
    }
    document.getElementById('holdForm').hidden = false;
  });
  document.getElementById('btnToggleReject').addEventListener('click', () => { document.getElementById('rejectForm').hidden = false; });
  document.getElementById('btnConfirmHold').addEventListener('click', async () => {
    try {
      await putDealOnHold(dealId, document.getElementById('holdReasonSelect').value, document.getElementById('holdRemarks').value);
      showToast('Put on hold.');
      await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); await refreshDealsList();
    } catch (err) { showToast(err.message || 'Could not put on hold.', true); }
  });
  document.getElementById('btnConfirmReject').addEventListener('click', async () => {
    try {
      await rejectDeal(dealId, document.getElementById('rejectReasonSelect').value, document.getElementById('rejectRemarks').value);
      showToast('Deal rejected.');
      await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); await refreshDealsList();
    } catch (err) { showToast(err.message || 'Could not reject.', true); }
  });
  const addTrancheBtn = document.getElementById('btnAddTranche');
  if (addTrancheBtn) addTrancheBtn.addEventListener('click', async () => {
    const num = Number(panel.querySelector('[data-tranche="tranche_number"]').value);
    const amount = Number(panel.querySelector('[data-tranche="amount"]').value);
    const date = panel.querySelector('[data-tranche="disbursed_date"]').value;
    const term = panel.querySelector('[data-tranche="academic_term"]').value;
    if (!amount || !date) { showToast('Enter amount and date.', true); return; }
    try { await recordDisbursement(dealId, num, amount, date, term); showToast('Tranche recorded.'); await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); }
    catch (err) { showToast(err.message || 'Could not record tranche.', true); }
  });
}

async function renderMessages(dealId) {
  const panel = document.getElementById('panelMessages');
  const messages = await getMessages(dealId);
  panel.innerHTML =
    (messages.length === 0 ? '<p class="empty-state">No messages yet.</p>' : messages.map((m) => `<div class="lender-app-card"><div style="font-size:11px;color:var(--ink-500);margin-bottom:4px;">${escapeHtml(m.sender?.full_name || 'Someone')} · ${formatDateTime(m.created_at)}</div>${escapeHtml(m.message)}</div>`).join('')) +
    '<div style="display:flex;gap:8px;margin-top:14px;"><textarea id="msgInput" rows="2" placeholder="Message the internal team…" style="flex:1;padding:9px 11px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;"></textarea><button class="btn btn-primary" id="btnSendMsg">Send</button></div>';
  document.getElementById('btnSendMsg').addEventListener('click', async () => {
    const text = document.getElementById('msgInput').value.trim();
    if (!text) return;
    await sendMessage(dealId, currentUser.id, text);
    await renderMessages(dealId);
  });
}

function initDrawerChrome() {
  document.getElementById('btnCloseDrawer').addEventListener('click', () => { document.getElementById('drawerOverlay').hidden = true; });
  document.getElementById('drawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'drawerOverlay') e.target.hidden = true; });
  document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });
}

async function bootstrap() {
  try {
    currentUser = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">Please sign in with a Lender account.</div>';
    return;
  }
  document.getElementById('userName').textContent = currentUser.fullName;
  document.getElementById('orgName').textContent = currentUser.lenderOrgName;
  document.getElementById('avatar').textContent = currentUser.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  // Send anyone whose role has no business on this screen to their own
  // home. RLS still decides what data they could read; this decides
  // which surface they are looking at.
  if (!guardDestination(currentUser, 'lender-pipeline')) return;
  applyNavPermissions(currentUser.role);
  mountTopbar({ app: 'lender-pipeline', user: currentUser });

  document.getElementById('lpTitle').textContent = currentUser.lenderOrgName;
  document.getElementById('lpBlurb').textContent =
    `Only cases Zolve Tangent has shared with ${currentUser.lenderOrgName}. Open a case to update its stage, answer queries or record a disbursement.`;

  initDrawerChrome();
  initViewSwitching();
  initProfileForm();
  initPipelineControls();
  await showView('pipeline');
}

function initPipelineControls() {
  let debounce;
  document.getElementById('lpSearch').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { pipe.search = e.target.value.trim(); pipe.shown = PAGE; renderRows(); }, 150);
  });
  document.getElementById('btnExport').addEventListener('click', exportView);
}

function initViewSwitching() {
  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.classList.remove('active'));
      el.classList.add('active');
      showView(el.dataset.view);
    });
  });
}

const LENDER_VIEW_CRUMBS = { pipeline: '', profile: 'Bank Details' };

async function showView(view) {
  document.getElementById('pipelinePanel').hidden = view !== 'pipeline';
  document.getElementById('profilePanel').hidden = view !== 'profile';
  setBreadcrumb(LENDER_VIEW_CRUMBS[view] ? [LENDER_VIEW_CRUMBS[view]] : []);
  if (view === 'pipeline') await refreshDealsList();
  else if (view === 'profile') await loadProfileForm();
}

function initProfileForm() {
  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await updateMyLenderProfile(currentUser.lenderOrgId, {
        contact_person_name: form.contact_person_name.value.trim() || null,
        contact_email: form.contact_email.value.trim() || null,
        contact_phone: form.contact_phone.value.trim() || null,
        registered_address: form.registered_address.value.trim() || null,
        processing_notes: form.processing_notes.value.trim() || null,
      });
      showToast('Bank details updated.');
    } catch (err) {
      showToast('Could not save changes.', true);
    }
  });
}

async function loadProfileForm() {
  const profile = await getMyLenderProfile(currentUser.lenderOrgId);
  const form = document.getElementById('profileForm');
  form.name.value = profile.name;
  form.contact_person_name.value = profile.contact_person_name || '';
  form.contact_email.value = profile.contact_email || '';
  form.contact_phone.value = profile.contact_phone || '';
  form.registered_address.value = profile.registered_address || '';
  form.processing_notes.value = profile.processing_notes || '';
}

guardBootstrap(bootstrap, 'Lender Pipeline');