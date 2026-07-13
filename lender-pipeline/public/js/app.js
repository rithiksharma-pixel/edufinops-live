import { getCurrentUser } from './services/authService.js';
import {
  getMyBankDeals, getDealDetail, getDealStages, getDealHoldReasons, getDealRejectionReasons,
  updateStageDetails, changeDealStage, putDealOnHold, releaseDealHold, rejectDeal, reinstateDeal,
  recordDisbursement, getMessages, sendMessage, STAGE_TABLE_MAP,
  getMyLenderProfile, updateMyLenderProfile, getDashboardSummary,
} from './services/lenderDealService.js';

let currentUser;
const toastEl = document.getElementById('toast');
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  setTimeout(() => (toastEl.hidden = true), 3000);
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
function formatCurrency(amount) {
  if (!amount) return '–';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}
function formatDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '–'; }
function formatDateTime(d) { return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'; }

async function refreshDealsList() {
  const tbody = document.getElementById('dealsBody');
  const deals = await getMyBankDeals();
  if (deals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No cases shared with your institution yet.</td></tr>';
    return;
  }
  tbody.innerHTML = deals.map((d) => {
    let banner = '';
    if (d.is_rejected) banner = '<span class="badge badge-danger">Rejected</span>';
    else if (d.is_on_hold) banner = '<span class="badge badge-warning">On hold</span>';
    return `<tr data-id="${d.id}">
      <td><strong>${escapeHtml(d.leads?.student_name || '–')}</strong></td>
      <td>${formatCurrency(d.leads?.loan_amount_requested)}</td>
      <td><span class="badge badge-accent">${escapeHtml(d.current_deal_stage?.name || '–')}${d.current_stage_status ? ' · ' + escapeHtml(d.current_stage_status.name) : ''}</span></td>
      <td>${banner || '–'}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDrawer(tr.dataset.id)));
}

async function openDrawer(dealId) {
  document.getElementById('drawerOverlay').hidden = false;
  const stages = await getDealStages();
  const holdReasons = await getDealHoldReasons();
  const rejectionReasons = await getDealRejectionReasons();
  await loadManagePanel(dealId, stages, holdReasons, rejectionReasons);
  await renderMessages(dealId);
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
      <button class="btn btn-primary" id="btnReinstate" style="width:100%;margin-top:10px;">Ask to reinstate</button>
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

  const nextStages = stages.filter((s) => s.id !== deal.current_deal_stage_id);
  const stageOptions = nextStages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
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
    <div class="form-field"><label>Advance to stage</label><select id="nextStageSelect"><option value="">Select…</option>${stageOptions}</select></div>
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
    } catch (err) { showToast('Could not change stage.', true); }
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
    } catch (err) { showToast('Could not put on hold.', true); }
  });
  document.getElementById('btnConfirmReject').addEventListener('click', async () => {
    try {
      await rejectDeal(dealId, document.getElementById('rejectReasonSelect').value, document.getElementById('rejectRemarks').value);
      showToast('Deal rejected.');
      await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); await refreshDealsList();
    } catch (err) { showToast('Could not reject.', true); }
  });
  const addTrancheBtn = document.getElementById('btnAddTranche');
  if (addTrancheBtn) addTrancheBtn.addEventListener('click', async () => {
    const num = Number(panel.querySelector('[data-tranche="tranche_number"]').value);
    const amount = Number(panel.querySelector('[data-tranche="amount"]').value);
    const date = panel.querySelector('[data-tranche="disbursed_date"]').value;
    const term = panel.querySelector('[data-tranche="academic_term"]').value;
    if (!amount || !date) { showToast('Enter amount and date.', true); return; }
    try { await recordDisbursement(dealId, num, amount, date, term); showToast('Tranche recorded.'); await loadManagePanel(dealId, stages, holdReasons, rejectionReasons); }
    catch (err) { showToast('Could not record tranche.', true); }
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

  initDrawerChrome();
  initViewSwitching();
  initProfileForm();
  await showView('dashboard');
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

async function showView(view) {
  document.getElementById('dashboardPanel').hidden = view !== 'dashboard';
  document.getElementById('pipelinePanel').hidden = view !== 'pipeline';
  document.getElementById('profilePanel').hidden = view !== 'profile';
  if (view === 'dashboard') await renderDashboard();
  else if (view === 'pipeline') await refreshDealsList();
  else if (view === 'profile') await loadProfileForm();
}

async function renderDashboard() {
  const summary = await getDashboardSummary();
  document.getElementById('dashStats').innerHTML = `
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;">${summary.totalDeals}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">Total cases</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;color:var(--danger);">${summary.needsAttention}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">Need attention</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;color:var(--success);">${summary.onTrack}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">On track</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;">${summary.closedWon}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">Closed won</div></div>
  `;

  const maxCount = Math.max(...Object.values(summary.stageCounts), 1);
  document.getElementById('dashStageBreakdown').innerHTML = Object.entries(summary.stageCounts).map(([name, count]) => `
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;"><span>${escapeHtml(name)}</span><span class="amount">${count}</span></div>
      <div style="background:var(--bg-hover);border-radius:4px;height:8px;"><div style="background:var(--accent);width:${(count / maxCount) * 100}%;height:100%;border-radius:4px;"></div></div>
    </div>
  `).join('') || '<p class="empty-state">No cases yet.</p>';

  const deals = await getMyBankDeals();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const flagged = deals.filter((d) => d.is_on_hold || d.is_rejected);
  document.getElementById('dashAttentionList').innerHTML = flagged.length
    ? flagged.map((d) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(d.leads?.student_name || '–')}</span><span class="badge ${d.is_rejected ? 'badge-danger' : 'badge-warning'}">${d.is_rejected ? 'Rejected' : 'On hold'}</span></div>`).join('')
    : '<p class="empty-state">Nothing needs attention right now.</p>';
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

bootstrap();
