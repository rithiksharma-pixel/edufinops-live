// =========================================================
// PRESENTATION LAYER — Deals tab (inside the lead detail drawer)
// Replaces the old flat "Lender applications" list. Each deal shows
// its current stage, the fields specific to that stage, and the
// actions available (advance stage, hold, reject, record tranche).
// =========================================================
import {
  getDealsForLead,
  getDealDetail,
  createDeal,
  updateStageDetails,
  changeDealStage,
  putDealOnHold,
  releaseDealHold,
  rejectDeal,
  reinstateDeal,
  recordDisbursement,
  STAGE_TABLE_MAP,
} from '../services/dealService.js';
import {
  getDealStages,
  getDealStageStatuses,
  getDealRejectionReasons,
  getDealHoldReasons,
  getLenders,
  getCounselors,
  getLoanOfficers,
} from '../services/lookupService.js';
import { getQueryCategories, getQueriesForDeal, raiseQuery, resolveQuery } from '../services/dealQueryService.js';
import { formatCurrency, formatDate, formatDateTime } from '../utils/validation.js';

export async function initDealsTab(panelEl, leadId, ctx) {
  const { currentUser, showToast, onDealUpdated } = ctx;

  async function refresh() {
    panelEl.innerHTML = '<p class="empty-state">Loading deals…</p>';
    const [deals, stages] = await Promise.all([getDealsForLead(leadId), getDealStages()]);

    panelEl.innerHTML = `
      <button class="btn btn-ghost" id="btnNewDeal" style="width:100%;justify-content:center;margin-bottom:14px;">
        <i class="fa-solid fa-plus"></i> Share with new lender
      </button>
      <div id="newDealForm"></div>
      <div id="dealCards"></div>
    `;

    const cardsWrap = document.getElementById('dealCards');
    if (deals.length === 0) {
      cardsWrap.innerHTML = '<p class="empty-state">Not shared with any lender yet.</p>';
    } else {
      deals.forEach((deal) => cardsWrap.appendChild(renderDealCard(deal, stages)));
    }

    document.getElementById('btnNewDeal').addEventListener('click', () => showNewDealForm());
  }

  function renderDealCard(deal, stages) {
    const wrap = document.createElement('div');
    wrap.className = 'lender-app-card';

    const stageName = deal.current_deal_stage?.name || '–';
    const statusName = deal.current_stage_status?.name;
    let banner = '';
    if (deal.is_rejected) {
      banner = `<div class="badge badge-danger" style="margin-top:6px;">Rejected${deal.rejection_reason ? ' · ' + escapeHtml(deal.rejection_reason.name) : ''}</div>`;
    } else if (deal.is_on_hold) {
      banner = `<div class="badge badge-warning" style="margin-top:6px;">On hold${deal.hold_reason ? ' · ' + escapeHtml(deal.hold_reason.name) : ''}</div>`;
    }

    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="lender-name">${escapeHtml(deal.lenders?.name || 'Unknown lender')}</div>
          <div style="font-size:12px;color:var(--ink-500);margin-top:2px;">
            ${escapeHtml(deal.assigned_counselor?.full_name || 'No counselor assigned')}
          </div>
        </div>
        <span class="badge badge-accent">${escapeHtml(stageName)}${statusName ? ' · ' + escapeHtml(statusName) : ''}</span>
      </div>
      ${banner}
      ${deal.total_disbursed_amount ? `<div class="detail-row"><span class="k">Disbursed so far</span><span class="v">${formatCurrency(deal.total_disbursed_amount)}</span></div>` : ''}
      <button class="btn btn-ghost" style="margin-top:10px;font-size:12px;padding:6px 12px;" data-manage="${deal.id}">Manage this deal</button>
      <div class="deal-detail-slot" data-slot="${deal.id}"></div>
    `;

    wrap.querySelector('[data-manage]').addEventListener('click', async (e) => {
      const slot = wrap.querySelector('.deal-detail-slot');
      if (slot.dataset.open === 'true') {
        slot.innerHTML = '';
        slot.dataset.open = 'false';
        e.target.textContent = 'Manage this deal';
        return;
      }
      slot.innerHTML = '<p class="empty-state" style="padding:12px 0;">Loading…</p>';
      slot.dataset.open = 'true';
      e.target.textContent = 'Hide';
      await loadDealDetail(deal.id, slot, stages);
    });

    return wrap;
  }

  async function loadDealDetail(dealId, slot, stages) {
    const [{ deal, stageDetails, disbursements }, stageStatuses, rejectionReasons, holdReasons, queries, queryCategories] = await Promise.all([
      getDealDetail(dealId),
      getDealStageStatuses(),
      getDealRejectionReasons(),
      getDealHoldReasons(),
      getQueriesForDeal(dealId),
      getQueryCategories(),
    ]);
    slot.innerHTML = '';
    slot.appendChild(renderDealDetail(deal, stageDetails, disbursements, stages, stageStatuses, rejectionReasons, holdReasons, queries, queryCategories));
  }

  function renderQueriesSection(deal, queries, queryCategories) {
    const openCount = queries.filter((q) => q.status === 'Open').length;
    const categoryOptions = queryCategories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    const queryRows = queries.length === 0
      ? '<p class="empty-state" style="padding:8px 0;">No queries raised yet.</p>'
      : queries.map((q) => `
        <div class="lender-app-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div class="lender-name">${escapeHtml(q.deal_query_categories?.name || 'Query')}</div>
              <div style="font-size:12px;color:var(--ink-500);margin-top:2px;">${escapeHtml(q.raised_by_user?.full_name || 'Someone')} · ${formatDateTime(q.created_at)}</div>
            </div>
            <span class="badge ${q.status === 'Resolved' ? '' : 'badge-warning'}">${escapeHtml(q.status)}</span>
          </div>
          <div style="font-size:13px;margin-top:6px;">${escapeHtml(q.question)}</div>
          ${q.status === 'Resolved'
            ? `<div class="detail-row"><span class="k">Resolution</span><span class="v">${escapeHtml(q.resolution || '–')}</span></div>`
            : `<div style="margin-top:8px;"><textarea data-resolve-input="${q.id}" rows="2" placeholder="Resolution…" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;"></textarea><button class="btn btn-ghost" style="margin-top:6px;" data-resolve="${q.id}">Mark resolved</button></div>`}
        </div>`).join('');

    return `
      <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Queries${openCount ? ` <span class="badge badge-warning">${openCount} open</span>` : ''}</h4>
      ${queryRows}
      <div style="margin-top:10px;">
        <div class="form-field"><label>Raise a query</label><select data-new-query-category>${categoryOptions}</select></div>
        <textarea data-new-query-question rows="2" placeholder="What's the question?" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;margin-top:6px;"></textarea>
        <button class="btn btn-ghost" style="margin-top:6px;" data-action="raise-query">Raise query</button>
      </div>
    `;
  }

  function wireQueriesSection(el, deal) {
    el.querySelector('[data-action="raise-query"]').addEventListener('click', async () => {
      const categoryId = el.querySelector('[data-new-query-category]').value;
      const question = el.querySelector('[data-new-query-question]').value.trim();
      if (!question) { showToast('Enter the question to raise.', true); return; }
      try {
        await raiseQuery(deal.id, categoryId, question, currentUser.id);
        showToast('Query raised.');
        await refresh();
      } catch (err) {
        showToast('Could not raise this query.', true);
      }
    });

    el.querySelectorAll('[data-resolve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const queryId = btn.dataset.resolve;
        const resolution = el.querySelector(`[data-resolve-input="${queryId}"]`).value.trim();
        if (!resolution) { showToast('Enter a resolution before marking this resolved.', true); return; }
        try {
          await resolveQuery(queryId, resolution, currentUser.id);
          showToast('Query resolved.');
          await refresh();
        } catch (err) {
          showToast('Could not resolve this query.', true);
        }
      });
    });
  }

  function renderDealDetail(deal, stageDetails, disbursements, stages, stageStatuses, rejectionReasons, holdReasons, queries, queryCategories) {
    const el = document.createElement('div');
    el.style.cssText = 'border-top:1px solid var(--border);margin-top:12px;padding-top:12px;';
    const stageName = deal.current_deal_stage?.name;

    if (deal.is_rejected) {
      el.innerHTML = `
        <div class="detail-row"><span class="k">Rejected at stage</span><span class="v">${escapeHtml(deal.current_deal_stage?.name || '–')}</span></div>
        <div class="detail-row"><span class="k">Rejection date</span><span class="v">${formatDateTime(deal.rejection_date)}</span></div>
        <div class="detail-row"><span class="k">Remarks</span><span class="v">${escapeHtml(deal.rejection_remarks || '–')}</span></div>
        <button class="btn btn-primary" style="margin-top:10px;width:100%;justify-content:center;" data-action="reinstate">Reinstate this deal</button>
        ${renderQueriesSection(deal, queries, queryCategories)}
      `;
      el.querySelector('[data-action="reinstate"]').addEventListener('click', async () => {
        try {
          await reinstateDeal(deal.id, 'Reinstated from drawer');
          showToast('Deal reinstated.');
          onDealUpdated();
          await refresh();
        } catch (err) {
          showToast('Could not reinstate this deal.', true);
        }
      });
      wireQueriesSection(el, deal);
      return el;
    }

    const stageConfig = STAGE_TABLE_MAP[stageName];
    let stageFormHtml = '';
    if (stageConfig && stageDetails) {
      stageFormHtml = stageConfig.fields
        .map((f) => {
          const val = stageDetails[f.key] ?? '';
          if (f.type === 'textarea') {
            return `<div class="form-field"><label>${f.label}</label><textarea data-field="${f.key}" rows="2">${escapeHtml(val)}</textarea></div>`;
          }
          return `<div class="form-field"><label>${f.label}</label><input data-field="${f.key}" type="${f.type}" value="${escapeHtml(val)}" /></div>`;
        })
        .join('');
    }

    const nextStages = stages.filter((s) => s.id !== deal.current_deal_stage_id);
    const stageOptions = nextStages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    const holdReasonOptions = holdReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
    const rejectionReasonOptions = rejectionReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

    let disbursementHtml = '';
    if (stageName === 'Disbursement' || stageName === 'Closed Won') {
      disbursementHtml = `
        <h4 style="font-size:13px;font-weight:500;margin:16px 0 8px;">Tranches</h4>
        ${disbursements.length === 0 ? '<p class="empty-state" style="padding:8px 0;">No tranches recorded yet.</p>' : ''}
        ${disbursements
          .map((d) => `<div class="detail-row"><span class="k">Tranche ${d.tranche_number}${d.academic_term ? ' · ' + escapeHtml(d.academic_term) : ''}</span><span class="v">${formatCurrency(d.amount)} · ${formatDate(d.disbursed_date)}</span></div>`)
          .join('')}
        ${stageName === 'Disbursement' ? `
        <div class="form-grid" style="margin-top:10px;">
          <div class="form-field"><label>Tranche number</label><input type="number" min="1" data-tranche="tranche_number" value="${disbursements.length + 1}" /></div>
          <div class="form-field"><label>Amount</label><input type="number" min="0" data-tranche="amount" /></div>
          <div class="form-field"><label>Disbursed date</label><input type="date" data-tranche="disbursed_date" /></div>
          <div class="form-field"><label>Academic term</label><input type="text" data-tranche="academic_term" placeholder="Year 1, Semester 1" /></div>
        </div>
        <button class="btn btn-ghost" style="margin-top:8px;" data-action="add-tranche">Add tranche</button>
        ` : ''}
      `;
    }

    el.innerHTML = `
      ${stageConfig ? `<h4 style="font-size:13px;font-weight:500;margin:0 0 8px;">${escapeHtml(stageName)} details</h4><div class="form-grid">${stageFormHtml}</div>
      <button class="btn btn-ghost" style="margin-top:8px;" data-action="save-stage-fields">Save details</button>` : ''}

      ${disbursementHtml}

      <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Actions</h4>
      <div class="form-field">
        <label>Advance to stage</label>
        <select data-action-field="next_stage_id"><option value="">Select a stage…</option>${stageOptions}</select>
      </div>
      <button class="btn btn-ghost" data-action="advance-stage">Move stage</button>

      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn btn-ghost" style="flex:1;" data-action="toggle-hold-form">${deal.is_on_hold ? 'Release hold' : 'Put on hold'}</button>
        <button class="btn btn-ghost" style="flex:1;color:var(--danger);" data-action="toggle-reject-form">Reject deal</button>
      </div>
      <div id="holdForm" hidden style="margin-top:10px;">
        <div class="form-field"><label>Hold reason</label><select data-field="hold_reason_id">${holdReasonOptions}</select></div>
        <div class="form-field"><label>Remarks</label><textarea data-field="hold_remarks" rows="2"></textarea></div>
        <button class="btn btn-primary" data-action="confirm-hold">Confirm hold</button>
      </div>
      <div id="rejectForm" hidden style="margin-top:10px;">
        <div class="form-field"><label>Rejection reason</label><select data-field="rejection_reason_id">${rejectionReasonOptions}</select></div>
        <div class="form-field"><label>Remarks</label><textarea data-field="rejection_remarks" rows="2"></textarea></div>
        <button class="btn btn-primary" style="background:var(--danger);" data-action="confirm-reject">Confirm rejection</button>
      </div>

      ${renderQueriesSection(deal, queries, queryCategories)}
    `;

    if (stageConfig) {
      el.querySelector('[data-action="save-stage-fields"]').addEventListener('click', async () => {
        const fields = {};
        el.querySelectorAll('[data-field]').forEach((input) => {
          if (input.closest('#holdForm') || input.closest('#rejectForm')) return;
          fields[input.dataset.field] = input.value || null;
        });
        try {
          await updateStageDetails(stageName, deal.id, fields);
          showToast('Details saved.');
        } catch (err) {
          showToast('Could not save details.', true);
        }
      });
    }

    el.querySelector('[data-action="advance-stage"]').addEventListener('click', async () => {
      const select = el.querySelector('[data-action-field="next_stage_id"]');
      if (!select.value) { showToast('Choose a stage to move to.', true); return; }
      try {
        await changeDealStage(deal.id, select.value, null, null);
        showToast('Deal moved to new stage.');
        onDealUpdated();
        await refresh();
      } catch (err) {
        showToast('Could not change stage.', true);
      }
    });

    el.querySelector('[data-action="toggle-hold-form"]').addEventListener('click', async () => {
      if (deal.is_on_hold) {
        try {
          await releaseDealHold(deal.id, null);
          showToast('Hold released.');
          onDealUpdated();
          await refresh();
        } catch (err) {
          showToast('Could not release hold.', true);
        }
        return;
      }
      const form = el.querySelector('#holdForm');
      form.hidden = !form.hidden;
    });

    el.querySelector('[data-action="toggle-reject-form"]').addEventListener('click', () => {
      const form = el.querySelector('#rejectForm');
      form.hidden = !form.hidden;
    });

    const holdConfirmBtn = el.querySelector('[data-action="confirm-hold"]');
    if (holdConfirmBtn) {
      holdConfirmBtn.addEventListener('click', async () => {
        const reasonId = el.querySelector('#holdForm [data-field="hold_reason_id"]').value;
        const remarks = el.querySelector('#holdForm [data-field="hold_remarks"]').value;
        try {
          await putDealOnHold(deal.id, reasonId, remarks);
          showToast('Deal put on hold.');
          onDealUpdated();
          await refresh();
        } catch (err) {
          showToast('Could not put this deal on hold.', true);
        }
      });
    }

    const rejectConfirmBtn = el.querySelector('[data-action="confirm-reject"]');
    if (rejectConfirmBtn) {
      rejectConfirmBtn.addEventListener('click', async () => {
        const reasonId = el.querySelector('#rejectForm [data-field="rejection_reason_id"]').value;
        const remarks = el.querySelector('#rejectForm [data-field="rejection_remarks"]').value;
        try {
          await rejectDeal(deal.id, reasonId, remarks);
          showToast('Deal rejected.');
          onDealUpdated();
          await refresh();
        } catch (err) {
          showToast('Could not reject this deal.', true);
        }
      });
    }

    const addTrancheBtn = el.querySelector('[data-action="add-tranche"]');
    if (addTrancheBtn) {
      addTrancheBtn.addEventListener('click', async () => {
        const trancheNumber = Number(el.querySelector('[data-tranche="tranche_number"]').value);
        const amount = Number(el.querySelector('[data-tranche="amount"]').value);
        const disbursedDate = el.querySelector('[data-tranche="disbursed_date"]').value;
        const academicTerm = el.querySelector('[data-tranche="academic_term"]').value;
        if (!amount || !disbursedDate) { showToast('Enter an amount and date for this tranche.', true); return; }
        try {
          await recordDisbursement(deal.id, trancheNumber, amount, disbursedDate, academicTerm, null);
          showToast('Tranche recorded.');
          onDealUpdated();
          await refresh();
        } catch (err) {
          showToast('Could not record this tranche.', true);
        }
      });
    }

    wireQueriesSection(el, deal);
    return el;
  }

  async function showNewDealForm() {
    const formWrap = document.getElementById('newDealForm');
    const [lenders, counselors, stages] = await Promise.all([getLenders(), getCounselors(), getDealStages()]);
    const firstStage = stages.find((s) => s.sequence_order === Math.min(...stages.map((s) => s.sequence_order)));

    formWrap.innerHTML = `
      <div class="lender-app-card">
        <div class="form-field"><label>Lender</label><select id="newDealLender"><option value="">Select…</option>${lenders.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Assigned counselor</label><select id="newDealCounselor"><option value="">Unassigned</option>${counselors.map((c) => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('')}</select></div>
        <div class="form-field"><label>Loan officer *</label><select id="newDealLoanOfficer"><option value="">Select a lender first</option></select></div>
        <p class="empty-state" style="padding:4px 0;font-size:12px;">Only the assigned loan officer at the lender will be able to see this deal.</p>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-ghost" id="btnCancelNewDeal" style="flex:1;">Cancel</button>
          <button class="btn btn-primary" id="btnSaveNewDeal" style="flex:1;">Share deal</button>
        </div>
      </div>
    `;

    document.getElementById('newDealLender').addEventListener('change', async (e) => {
      const officerSelect = document.getElementById('newDealLoanOfficer');
      if (!e.target.value) { officerSelect.innerHTML = '<option value="">Select a lender first</option>'; return; }
      officerSelect.innerHTML = '<option value="">Loading…</option>';
      const officers = await getLoanOfficers(e.target.value);
      officerSelect.innerHTML = officers.length
        ? `<option value="">Select…</option>` + officers.map((o) => `<option value="${o.id}">${escapeHtml(o.full_name)}${o.lender_branches ? ' — ' + escapeHtml(o.lender_branches.name) : ''}</option>`).join('')
        : '<option value="">No one at this lender yet — invite them first</option>';
    });

    document.getElementById('btnCancelNewDeal').addEventListener('click', () => { formWrap.innerHTML = ''; });
    document.getElementById('btnSaveNewDeal').addEventListener('click', async () => {
      const lenderId = document.getElementById('newDealLender').value;
      const counselorId = document.getElementById('newDealCounselor').value || null;
      const loanOfficerId = document.getElementById('newDealLoanOfficer').value || null;
      if (!lenderId) { showToast('Choose a lender.', true); return; }
      if (!loanOfficerId) { showToast('Choose the loan officer this deal should be assigned to — otherwise no one at the lender can see it.', true); return; }
      try {
        await createDeal({ leadId, lenderId, assignedCounselorId: counselorId, assignedLoanOfficerId: loanOfficerId }, firstStage.id, currentUser.id);
        showToast('Deal created.');
        formWrap.innerHTML = '';
        onDealUpdated();
        await refresh();
      } catch (err) {
        showToast(err.message || 'Could not create this deal.', true);
      }
    });
  }

  await refresh();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
