// =========================================================
// PRESENTATION LAYER — Manual lender-deal management (RM Workspace)
// Lets an RM pick one of their leads, see every lender for it (Shared/
// Not Shared, mirroring lead-management's lenderStatusPanel.js), start a
// deal with a lender that has no loan officer yet, and manage it: region,
// stage + disposition, stage fields, hold/reject overlays, and
// disbursement tranches — the same set of actions available from
// lead-management's "Manage this deal" panel (dealPanel.js), reused here
// since no lender exists yet to drive these from their own portal. The
// disposition picker is new there too — the data (deal_stage_statuses)
// and RPC support it, but no UI in this codebase rendered it before this.
// =========================================================
import {
  getDealStages,
  getDealStageStatuses,
  getDealHoldReasons,
  getDealRejectionReasons,
  getLenderBranches,
  getLeadLenderStatusRows,
  startDeal,
  getDealDetail,
  updateDealRegion,
  updateStageDetails,
  changeDealStage,
  putDealOnHold,
  releaseDealHold,
  rejectDeal,
  reinstateDeal,
  recordDisbursement,
  STAGE_TABLE_MAP,
} from '../services/lenderDealService.js';
import { escapeHtml, formatCurrency, formatDate } from '../utils/validation.js';

export async function initLenderDealPanel(containerEl, ctx) {
  const { showToast, getLeads } = ctx;
  const leadSelect = containerEl.querySelector('#lenderPanelLeadSelect');
  const rowsEl = containerEl.querySelector('#lenderPanelRows');
  let initialized = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    const leads = await getLeads();
    leadSelect.innerHTML = '<option value="">Choose a lead…</option>' +
      leads.map((l) => `<option value="${l.id}">${escapeHtml(l.student_name)}</option>`).join('');
    leadSelect.addEventListener('change', refresh);
  }

  async function refresh() {
    const leadId = leadSelect.value;
    if (!leadId) { rowsEl.innerHTML = ''; return; }
    rowsEl.innerHTML = '<p class="empty-state">Loading…</p>';
    const [rows, stages, stageStatuses, holdReasons, rejectionReasons] = await Promise.all([
      getLeadLenderStatusRows(leadId),
      getDealStages(),
      getDealStageStatuses(),
      getDealHoldReasons(),
      getDealRejectionReasons(),
    ]);
    if (rows.length === 0) {
      rowsEl.innerHTML = '<div class="empty-state-block"><div class="icon"><i class="fa-solid fa-building-columns"></i></div><div class="title">No lenders configured yet</div><p class="hint">Ask an Admin to add a lender first.</p></div>';
      return;
    }
    rowsEl.innerHTML = `
      <table class="lender-matrix-table">
        <thead><tr><th>Lender</th><th>Status</th><th>Stage</th><th></th></tr></thead>
        <tbody>${rows.map(renderRow).join('')}</tbody>
      </table>
    `;
    wireRows(stages, stageStatuses, holdReasons, rejectionReasons);
  }

  function renderRow(row) {
    const isShared = row.share_status === 'Shared';
    const stageName = row.deals?.current_deal_stage?.name;
    const statusName = row.deals?.current_stage_status?.name;
    const statusCell = isShared
      ? '<span class="lender-status-badge shared"><span class="dot"></span>Shared</span>'
      : '<span class="lender-status-badge not-shared"><span class="dot"></span>Not Shared</span>';

    return `
      <tr>
        <td><strong>${escapeHtml(row.lenders?.name || 'Unknown')}</strong></td>
        <td>${statusCell}</td>
        <td>${isShared ? escapeHtml(stageName || '–') + (statusName ? ' · ' + escapeHtml(statusName) : '') : '–'}</td>
        <td>
          ${isShared
            ? `<button class="btn btn-ghost" data-manage="${row.deals.id}" style="font-size:12px;padding:5px 10px;">Manage</button>`
            : `<button class="btn btn-ghost" data-start="${row.id}" style="font-size:12px;padding:5px 10px;">Start deal</button>`}
          <div class="deal-detail-slot" data-slot="${row.id}"></div>
        </td>
      </tr>
    `;
  }

  function wireRows(stages, stageStatuses, holdReasons, rejectionReasons) {
    rowsEl.querySelectorAll('[data-start]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await startDeal(btn.dataset.start, null);
          showToast('Deal started.');
          await refresh();
        } catch (err) {
          showToast(err.message || 'Could not start this deal.', true);
          btn.disabled = false;
        }
      });
    });

    rowsEl.querySelectorAll('[data-manage]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const slot = btn.closest('tr').querySelector('.deal-detail-slot');
        if (slot.dataset.open === 'true') {
          slot.innerHTML = '';
          slot.dataset.open = 'false';
          btn.textContent = 'Manage';
          return;
        }
        slot.innerHTML = '<p class="empty-state" style="padding:10px 0;">Loading…</p>';
        slot.dataset.open = 'true';
        btn.textContent = 'Hide';
        await loadManageForm(btn.dataset.manage, slot, stages, stageStatuses, holdReasons, rejectionReasons);
      });
    });
  }

  async function loadManageForm(dealId, slot, stages, stageStatuses, holdReasons, rejectionReasons) {
    const { deal, stageDetails, disbursements } = await getDealDetail(dealId);
    const branches = await getLenderBranches(deal.lender_id);
    slot.innerHTML = '';
    slot.appendChild(renderManageForm(deal, stageDetails, disbursements, branches, stages, stageStatuses, holdReasons, rejectionReasons));
  }

  function renderManageForm(deal, stageDetails, disbursements, branches, stages, stageStatuses, holdReasons, rejectionReasons) {
    const el = document.createElement('div');
    el.style.cssText = 'border-top:1px solid var(--border);margin-top:10px;padding-top:10px;text-align:left;';
    const stageName = deal.current_deal_stage?.name;

    if (deal.is_rejected) {
      el.innerHTML = `
        <div class="detail-row"><span class="k">Rejected at stage</span><span class="v">${escapeHtml(stageName || '–')}</span></div>
        <div class="detail-row"><span class="k">Reason</span><span class="v">${escapeHtml(deal.rejection_reason?.name || '–')}</span></div>
        <div class="detail-row"><span class="k">Remarks</span><span class="v">${escapeHtml(deal.rejection_remarks || '–')}</span></div>
        <button class="btn btn-primary" style="margin-top:10px;" data-action="reinstate">Reinstate this deal</button>
      `;
      el.querySelector('[data-action="reinstate"]').addEventListener('click', async () => {
        try {
          await reinstateDeal(deal.id, 'Reinstated from RM Workspace');
          showToast('Deal reinstated.');
          await refresh();
        } catch (err) {
          showToast('Could not reinstate this deal.', true);
        }
      });
      return el;
    }

    const stageConfig = STAGE_TABLE_MAP[stageName];
    const banner = deal.is_on_hold
      ? `<div class="badge badge-warning" style="margin-bottom:10px;">On hold${deal.hold_reason ? ' · ' + escapeHtml(deal.hold_reason.name) : ''}</div>`
      : '';

    const branchOptions = '<option value="">No region set</option>' +
      branches.map((b) => `<option value="${b.id}" ${b.id === deal.lender_branch_id ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');

    const nextStages = stages.filter((s) => s.id !== deal.current_deal_stage_id);
    const stageOptions = '<option value="">Keep current stage</option>' +
      nextStages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

    let stageFormHtml = '';
    if (stageConfig && stageDetails) {
      stageFormHtml = stageConfig.fields.map((f) => {
        const val = stageDetails[f.key] ?? '';
        if (f.type === 'textarea') {
          return `<div class="form-field"><label>${f.label}</label><textarea data-field="${f.key}" rows="2">${escapeHtml(val)}</textarea></div>`;
        }
        return `<div class="form-field"><label>${f.label}</label><input data-field="${f.key}" type="${f.type}" value="${escapeHtml(val)}" /></div>`;
      }).join('');
    }

    let disbursementHtml = '';
    if (stageName === 'Disbursement' || stageName === 'Closed Won') {
      disbursementHtml = `
        <h4 style="font-size:13px;font-weight:500;margin:16px 0 8px;">Tranches</h4>
        ${disbursements.length === 0 ? '<p class="empty-state" style="padding:8px 0;">No tranches recorded yet.</p>' : ''}
        ${disbursements.map((d) => `<div class="detail-row"><span class="k">Tranche ${d.tranche_number}${d.academic_term ? ' · ' + escapeHtml(d.academic_term) : ''}</span><span class="v">${formatCurrency(d.amount)} · ${formatDate(d.disbursed_date)}</span></div>`).join('')}
        ${stageName === 'Disbursement' ? `
        <div class="form-grid" style="margin-top:10px;">
          <div class="form-field"><label>Tranche number</label><input type="number" min="1" data-tranche="tranche_number" value="${disbursements.length + 1}" /></div>
          <div class="form-field"><label>Amount</label><input type="number" min="0" data-tranche="amount" /></div>
          <div class="form-field"><label>Disbursed date</label><input type="date" data-tranche="disbursed_date" /></div>
          <div class="form-field"><label>Academic term</label><input type="text" data-tranche="academic_term" placeholder="Year 1, Semester 1" /></div>
        </div>
        <button class="btn btn-ghost" data-action="add-tranche">Add tranche</button>
        ` : ''}
      `;
    }

    const holdReasonOptions = holdReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
    const rejectionReasonOptions = rejectionReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

    el.innerHTML = `
      ${banner}
      <div class="form-field" style="max-width:320px;">
        <label>Region</label>
        <select data-action-field="region">${branchOptions}</select>
      </div>
      <button class="btn btn-ghost" data-action="save-region" style="margin-bottom:14px;">Save region</button>

      ${stageConfig ? `<h4 style="font-size:13px;font-weight:500;margin:0 0 8px;">${escapeHtml(stageName)} details</h4><div class="form-grid">${stageFormHtml}</div>
      <button class="btn btn-ghost" data-action="save-stage-fields">Save details</button>` : ''}

      ${disbursementHtml}

      <h4 style="font-size:13px;font-weight:500;margin:18px 0 8px;">Move stage</h4>
      <div class="form-grid">
        <div class="form-field">
          <label>Stage</label>
          <select data-action-field="next_stage_id">${stageOptions}</select>
        </div>
        <div class="form-field">
          <label>Disposition</label>
          <select data-action-field="next_status_id"><option value="">Select a stage first…</option></select>
        </div>
      </div>
      <button class="btn btn-primary" data-action="advance-stage">Save stage &amp; disposition</button>

      <div style="display:flex;gap:8px;margin-top:14px;">
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
    `;

    const stageSelect = el.querySelector('[data-action-field="next_stage_id"]');
    const statusSelect = el.querySelector('[data-action-field="next_status_id"]');
    stageSelect.addEventListener('change', () => {
      const stageId = stageSelect.value;
      const options = stageStatuses.filter((s) => s.deal_stage_id === stageId);
      statusSelect.innerHTML = stageId
        ? '<option value="">No disposition</option>' + options.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')
        : '<option value="">Select a stage first…</option>';
    });

    el.querySelector('[data-action="save-region"]').addEventListener('click', async () => {
      const branchId = el.querySelector('[data-action-field="region"]').value;
      try {
        await updateDealRegion(deal.id, branchId);
        showToast('Region saved.');
      } catch (err) {
        showToast('Could not save the region.', true);
      }
    });

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
          await refresh();
        } catch (err) {
          showToast('Could not record this tranche.', true);
        }
      });
    }

    el.querySelector('[data-action="advance-stage"]').addEventListener('click', async () => {
      if (!stageSelect.value) { showToast('Choose a stage to move to.', true); return; }
      try {
        await changeDealStage(deal.id, stageSelect.value, statusSelect.value || null, null);
        showToast('Deal updated.');
        await refresh();
      } catch (err) {
        showToast('Could not update this deal.', true);
      }
    });

    el.querySelector('[data-action="toggle-hold-form"]').addEventListener('click', async () => {
      if (deal.is_on_hold) {
        try {
          await releaseDealHold(deal.id, null);
          showToast('Hold released.');
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
          await refresh();
        } catch (err) {
          showToast('Could not reject this deal.', true);
        }
      });
    }

    return el;
  }

  await init();
  await refresh();
}
