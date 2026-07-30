// =========================================================
// PRESENTATION LAYER — Lender progress tree (Lenders tab)
//
// A lead shared with 2-3 lenders has that many parallel journeys, but the
// Lenders tab below this only shows each one's CURRENT state — answering
// "how did we get here, and when" meant opening each deal's "Manage"
// panel one at a time. This renders one column per lender-deal, each a
// small vertical timeline of the stage transitions that deal actually
// went through, so multiple lenders' progress reads side by side.
//
// getDealEvents() already existed (dealService.js) but had no caller
// anywhere in the app — it's exactly the per-deal history this needed.
// =========================================================
import { getDealsForLead, getDealEvents } from '../services/dealService.js';
import { formatDateTime } from '../utils/validation.js';

export async function initDealTimelineTree(container, leadId) {
  async function refresh() {
    const deals = await getDealsForLead(leadId);
    if (deals.length === 0) {
      // dealPanel's own "not shared with any lender yet" empty state
      // already covers this immediately below — no need to say it twice.
      container.innerHTML = '';
      return;
    }

    const eventsByDeal = await Promise.all(deals.map((deal) => getDealEvents(deal.id)));

    container.innerHTML = `
      <h4 style="font-size:13px;font-weight:500;margin:0 0 10px;">Lender progress</h4>
      <div class="deal-tree">
        ${deals.map((deal, i) => renderBranch(deal, eventsByDeal[i])).join('')}
      </div>
    `;
  }

  await refresh();
  return { refresh };
}

function renderBranch(deal, events) {
  const stageName = deal.current_deal_stage?.name || '–';
  const statusName = deal.current_stage_status?.name;

  let banner = '';
  if (deal.is_rejected) {
    banner = `<div class="badge badge-danger">Rejected${deal.rejection_reason ? ' · ' + escapeHtml(deal.rejection_reason.name) : ''}</div>`;
  } else if (deal.is_on_hold) {
    banner = `<div class="badge badge-warning">On hold${deal.hold_reason ? ' · ' + escapeHtml(deal.hold_reason.name) : ''}</div>`;
  }

  const timelineHtml = events.length === 0
    ? '<p class="empty-state" style="padding:8px 0;font-size:12px;">No stage moves recorded yet.</p>'
    : events.map((ev) => `
      <div class="timeline-item">
        <div class="timeline-marker-col"><div class="timeline-dot"></div></div>
        <div class="timeline-content">
          <div class="timeline-event">${escapeHtml(ev.to_stage?.name || ev.event_type)}</div>
          <div class="timeline-meta">${formatDateTime(ev.created_at)}</div>
          ${ev.remarks ? `<div class="timeline-remarks">${escapeHtml(ev.remarks)}</div>` : ''}
        </div>
      </div>`).join('');

  return `
    <div class="deal-branch">
      <div class="deal-branch-header">
        <div class="lender-name">${escapeHtml(deal.lenders?.name || 'Unknown lender')}</div>
        <span class="badge badge-accent">${escapeHtml(stageName)}${statusName ? ' · ' + escapeHtml(statusName) : ''}</span>
        ${banner}
      </div>
      <div class="deal-branch-timeline">${timelineHtml}</div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
