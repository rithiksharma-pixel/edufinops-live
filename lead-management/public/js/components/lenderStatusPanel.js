// =========================================================
// PRESENTATION LAYER — Lender status matrix (top of the Lenders tab)
// One row per active lender for this lead. "Not Shared" rows get a
// reason picker; "Shared" rows show which officer + deal stage. Marking
// a row Shared opens an inline officer picker (required — a deal is
// only visible to the specific person it's assigned to at a lender).
// =========================================================
import { getLenderStatusForLead, getNotSharedReasons, updateNotSharedReason, shareLeadWithLender } from '../services/lenderStatusService.js';
import { getLoanOfficers } from '../services/lookupService.js';

const OTHER_REASON_VALUE = '__other__';

export async function initLenderStatusPanel(panelEl, leadId, ctx) {
  const { showToast, currentUser, onShared } = ctx;
  const canEdit = ['Admin', 'Manager', 'Relationship Manager'].includes(currentUser.role);

  async function refresh() {
    panelEl.innerHTML = '<p class="empty-state">Loading lenders…</p>';
    const [rows, reasons] = await Promise.all([getLenderStatusForLead(leadId), getNotSharedReasons()]);

    if (rows.length === 0) {
      panelEl.innerHTML = '<p class="empty-state">No lenders configured yet — add one in Admin Settings.</p>';
      return;
    }

    const otherReason = reasons.find((r) => r.name === 'Other');
    const buildReasonOptions = (selectedReasonId, isOtherSelected) => {
      const namedOptions = reasons.filter((r) => r.name !== 'Other').map((r) =>
        `<option value="${r.id}" ${r.id === selectedReasonId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
      ).join('');
      return `<option value="">Select a reason…</option>${namedOptions}<option value="${OTHER_REASON_VALUE}" ${isOtherSelected ? 'selected' : ''}>Other</option>`;
    };

    panelEl.innerHTML = `
      <h4 style="font-size:13px;font-weight:500;margin:0 0 10px;">Lenders</h4>
      <table class="lender-matrix-table">
        <thead><tr><th>Lender</th><th>Status</th><th>Detail</th><th></th></tr></thead>
        <tbody>
          ${rows.map((row) => renderRow(row, buildReasonOptions, canEdit)).join('')}
        </tbody>
      </table>
    `;

    if (!canEdit) return;

    rows.forEach((row) => {
      if (row.share_status === 'Shared') return;

      const reasonSelect = panelEl.querySelector(`[data-reason-for="${row.id}"]`);
      const otherInput = panelEl.querySelector(`[data-reason-other-for="${row.id}"]`);
      reasonSelect?.addEventListener('change', () => {
        const isOther = reasonSelect.value === OTHER_REASON_VALUE;
        if (otherInput) otherInput.hidden = !isOther;
      });

      const saveReasonBtn = panelEl.querySelector(`[data-save-reason="${row.id}"]`);
      saveReasonBtn?.addEventListener('click', async () => {
        const isOther = reasonSelect.value === OTHER_REASON_VALUE;
        const reasonId = isOther ? otherReason?.id ?? null : reasonSelect.value || null;
        const otherText = isOther ? otherInput.value.trim() : null;
        try {
          await updateNotSharedReason(row.id, reasonId, otherText);
          showToast('Reason saved.');
          await refresh();
        } catch (err) {
          showToast('Could not save this reason.', true);
        }
      });

      const shareBtn = panelEl.querySelector(`[data-share="${row.id}"]`);
      shareBtn?.addEventListener('click', () => showShareForm(row));
    });
  }

  async function showShareForm(row) {
    const slot = panelEl.querySelector(`[data-share-slot="${row.id}"]`);
    if (!slot) return;
    slot.innerHTML = `
      <div class="lender-matrix-reason-row" style="margin-top:8px;">
        <select data-share-officer style="min-width:220px;"><option value="">Loading officers…</option></select>
        <button class="btn btn-primary" data-confirm-share style="font-size:12px;padding:6px 12px;">Confirm share</button>
        <button class="btn btn-ghost" data-cancel-share style="font-size:12px;padding:6px 12px;">Cancel</button>
      </div>
      <p class="empty-state" style="padding:4px 0;font-size:12px;">Only the officer picked here will be able to see this deal.</p>
    `;

    const officerSelect = slot.querySelector('[data-share-officer]');
    const officers = await getLoanOfficers(row.lenders.id);
    officerSelect.innerHTML = officers.length
      ? `<option value="">Select…</option>` + officers.map((o) => `<option value="${o.id}">${escapeHtml(o.full_name)}${o.lender_branches ? ' — ' + escapeHtml(o.lender_branches.name) : ''}</option>`).join('')
      : '<option value="">No one at this lender yet — invite them first</option>';

    slot.querySelector('[data-cancel-share]').addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('[data-confirm-share]').addEventListener('click', async () => {
      const officerId = officerSelect.value;
      if (!officerId) { showToast('Choose the loan officer this deal should be assigned to.', true); return; }
      try {
        await shareLeadWithLender(row.id, officerId, null);
        showToast(`Shared with ${row.lenders.name}.`);
        await refresh();
        onShared?.();
      } catch (err) {
        showToast(err.message || 'Could not share with this lender.', true);
      }
    });
  }

  function renderRow(row, buildReasonOptions, canEdit) {
    const isShared = row.share_status === 'Shared';
    const statusBadge = isShared
      ? `<span class="lender-status-badge shared">Shared</span>`
      : `<span class="lender-status-badge not-shared">Not Shared</span>`;
    const isOtherSelected = row.lead_lender_not_shared_reasons?.name === 'Other';

    let detail;
    if (isShared) {
      const stageName = row.deals?.current_deal_stage?.name || '–';
      const officerName = row.deals?.assigned_loan_officer?.full_name || '–';
      detail = `${escapeHtml(officerName)} · ${escapeHtml(stageName)}`;
    } else {
      const reasonText = isOtherSelected ? (row.not_shared_other_text || '–') : (row.lead_lender_not_shared_reasons?.name || '–');
      detail = canEdit
        ? `<div class="lender-matrix-reason-row">
            <select data-reason-for="${row.id}">${buildReasonOptions(row.not_shared_reason_id, isOtherSelected)}</select>
            <input type="text" data-reason-other-for="${row.id}" placeholder="Reason…" value="${escapeHtml(row.not_shared_other_text || '')}" ${isOtherSelected ? '' : 'hidden'} style="min-width:160px;" />
            <button class="btn btn-ghost" data-save-reason="${row.id}" style="font-size:12px;padding:5px 10px;">Save</button>
          </div>`
        : escapeHtml(reasonText);
    }

    return `
      <tr>
        <td><strong>${escapeHtml(row.lenders?.name || 'Unknown')}</strong></td>
        <td>${statusBadge}</td>
        <td>${detail}</td>
        <td>
          ${!isShared && canEdit ? `<button class="btn btn-ghost" data-share="${row.id}" style="font-size:12px;padding:5px 10px;">Share</button>` : ''}
          <div data-share-slot="${row.id}"></div>
        </td>
      </tr>
    `;
  }

  await refresh();
  return { refresh };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
