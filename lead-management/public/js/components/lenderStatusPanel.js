// =========================================================
// PRESENTATION LAYER — Lender status list (top of the Lenders tab)
// One row per active lender for this lead. "Not Shared" rows can set a
// reason and/or Share; "Shared" rows show the officer + deal stage.
// Reason-edit and Share both expand inline into the same per-row slot
// (only one open at a time) rather than showing form controls on every
// row up front — keeps the list scannable when there are 15+ lenders.
// =========================================================
import { getLenderStatusForLead, getNotSharedReasons, updateNotSharedReason, shareLeadWithLender } from '../services/lenderStatusService.js';
import { getLoanOfficers } from '../services/lookupService.js';
import { emptyState } from '../../../../shared/js/emptyState.js';

const OTHER_REASON_VALUE = '__other__';

export async function initLenderStatusPanel(panelEl, leadId, ctx) {
  const { showToast, currentUser, onShared } = ctx;
  const canEdit = ['Admin', 'Manager', 'Relationship Manager'].includes(currentUser.role);

  async function refresh() {
    panelEl.innerHTML = '<p class="empty-state">Loading lenders…</p>';
    const [rows, reasons] = await Promise.all([getLenderStatusForLead(leadId), getNotSharedReasons()]);

    const tabCountEl = document.getElementById('lendersTabCount');
    if (tabCountEl) tabCountEl.textContent = `${rows.filter((r) => r.share_status === 'Shared').length}/${rows.length}`;

    if (rows.length === 0) {
      panelEl.innerHTML = emptyState('fa-building-columns', 'No lenders configured yet', 'Add a lender in Admin Settings and it will appear here for sharing.');
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
      <div class="lender-row-list">
        ${rows.map((row) => renderRow(row)).join('')}
      </div>
    `;

    if (!canEdit) return;

    rows.forEach((row) => {
      if (row.share_status === 'Shared') return;
      const isOtherSelected = row.lead_lender_not_shared_reasons?.name === 'Other';

      panelEl.querySelector(`[data-reason-toggle="${row.id}"]`)?.addEventListener('click', () => {
        toggleExpand(row.id, 'reason', () => renderReasonForm(row, buildReasonOptions, isOtherSelected, otherReason));
      });
      panelEl.querySelector(`[data-share="${row.id}"]`)?.addEventListener('click', () => {
        toggleExpand(row.id, 'share', () => renderShareForm(row));
      });
    });
  }

  /** Only one expand (reason-edit or share) open per row at a time. */
  function toggleExpand(rowId, mode, render) {
    const slot = panelEl.querySelector(`[data-expand-slot="${rowId}"]`);
    if (!slot) return;
    if (slot.dataset.mode === mode) {
      slot.innerHTML = '';
      slot.dataset.mode = '';
      return;
    }
    slot.dataset.mode = mode;
    render(slot);
  }

  function renderReasonForm(row, buildReasonOptions, isOtherSelected, otherReason) {
    const slot = panelEl.querySelector(`[data-expand-slot="${row.id}"]`);
    slot.innerHTML = `
      <div class="lender-matrix-reason-row">
        <select data-reason-for="${row.id}">${buildReasonOptions(row.not_shared_reason_id, isOtherSelected)}</select>
        <input type="text" data-reason-other-for="${row.id}" placeholder="Reason…" value="${escapeHtml(row.not_shared_other_text || '')}" ${isOtherSelected ? '' : 'hidden'} style="min-width:160px;" />
        <button class="btn btn-primary" data-save-reason="${row.id}" style="font-size:12px;padding:6px 12px;">Save</button>
        <button class="btn btn-ghost" data-cancel-reason style="font-size:12px;padding:6px 12px;">Cancel</button>
      </div>
    `;
    const reasonSelect = slot.querySelector(`[data-reason-for="${row.id}"]`);
    const otherInput = slot.querySelector(`[data-reason-other-for="${row.id}"]`);
    reasonSelect.addEventListener('change', () => {
      const isOther = reasonSelect.value === OTHER_REASON_VALUE;
      otherInput.hidden = !isOther;
    });
    slot.querySelector('[data-cancel-reason]').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.mode = ''; });
    slot.querySelector(`[data-save-reason="${row.id}"]`).addEventListener('click', async () => {
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
  }

  function renderShareForm(row) {
    const slot = panelEl.querySelector(`[data-expand-slot="${row.id}"]`);
    slot.innerHTML = `
      <div class="lender-matrix-reason-row">
        <select data-share-officer style="min-width:220px;"><option value="">Loading officers…</option></select>
        <button class="btn btn-primary" data-confirm-share style="font-size:12px;padding:6px 12px;">Confirm share</button>
        <button class="btn btn-ghost" data-cancel-share style="font-size:12px;padding:6px 12px;">Cancel</button>
      </div>
      <p class="empty-state" style="padding:4px 0;font-size:12px;text-align:left;">Only the officer picked here will be able to see this deal — leave it unset if this lender isn't onboarded yet, and assign one later.</p>
    `;

    const officerSelect = slot.querySelector('[data-share-officer]');
    getLoanOfficers(row.lenders.id).then((officers) => {
      officerSelect.innerHTML = '<option value="">No officer yet</option>' +
        officers.map((o) => `<option value="${o.id}">${escapeHtml(o.full_name)}${o.lender_branches ? ' — ' + escapeHtml(o.lender_branches.name) : ''}</option>`).join('');
    });

    slot.querySelector('[data-cancel-share]').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.mode = ''; });
    slot.querySelector('[data-confirm-share]').addEventListener('click', async () => {
      const officerId = officerSelect.value || null;
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

  function renderRow(row) {
    const isShared = row.share_status === 'Shared';
    const isOtherSelected = row.lead_lender_not_shared_reasons?.name === 'Other';

    if (isShared) {
      const stageName = row.deals?.current_deal_stage?.name || '–';
      const officerName = row.deals?.assigned_loan_officer?.full_name || '–';
      return `
        <div class="lender-row">
          <div class="lender-row-main">
            <span class="lender-stamp-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12l4 4L19 6"/></svg></span>
            <span class="lender-row-name">${escapeHtml(row.lenders?.name || 'Unknown')}</span>
          </div>
          <div class="lender-row-detail">
            <span class="lender-status-badge shared"><span class="dot"></span>Shared</span>
            <span style="margin-left:10px;">${escapeHtml(officerName)} · ${escapeHtml(stageName)}</span>
          </div>
          <div class="lender-row-actions"></div>
        </div>
      `;
    }

    const reasonText = isOtherSelected ? (row.not_shared_other_text || null) : (row.lead_lender_not_shared_reasons?.name || null);
    const attribution = row.not_shared_reason_id && row.updated_by_user
      ? `<span class="lender-matrix-reason-who">Marked by ${escapeHtml(row.updated_by_user.full_name)}, ${formatRelative(row.updated_at)}</span>`
      : '';

    return `
      <div class="lender-row">
        <div class="lender-row-main">
          <span class="lender-row-name">${escapeHtml(row.lenders?.name || 'Unknown')}</span>
        </div>
        <div class="lender-row-detail">
          <span class="lender-status-badge not-shared"><span class="dot"></span>Not Shared</span>
          ${reasonText ? `<span style="margin-left:10px;">${escapeHtml(reasonText)}</span>` : ''}
          ${attribution}
        </div>
        <div class="lender-row-actions">
          ${canEdit ? `
            <button class="btn btn-ghost" data-reason-toggle="${row.id}" style="font-size:12px;padding:5px 10px;">${reasonText ? 'Edit reason' : 'Add reason'}</button>
            <button class="btn btn-primary" data-share="${row.id}" style="font-size:12px;padding:5px 10px;">Share</button>
          ` : ''}
        </div>
        <div class="lender-row-expand" data-expand-slot="${row.id}"></div>
      </div>
    `;
  }

  function formatRelative(iso) {
    if (!iso) return '';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  await refresh();
  return { refresh };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
