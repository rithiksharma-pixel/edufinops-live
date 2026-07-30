// =========================================================
// PRESENTATION LAYER — "Where is this lead at?" summary
//
// Sits at the top of the Overview tab. The question an RM opens a lead to
// answer is almost never "what is this person's email" — it's "where is
// this going, what did we last say, and who has said yes". Answering that
// previously meant reading Lead basics, then the Timeline tab, then the
// Lenders tab, and holding all three in your head.
//
// Everything here is derived from data the drawer has already fetched or
// can fetch in one extra call — no new tables, no summarisation model.
// =========================================================
import { CALL_STATUS_OPTIONS, CONNECTED_DISPOSITIONS } from '../services/leadService.js';
import { getLenderStatusForLead } from '../services/lenderStatusService.js';
import { formatCurrency } from '../utils/validation.js';

const HOW_MANY_CALLS = 3;

/** "12 Feb" — short, because these sit in a dense list. */
function shortDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

/** Whole days between then and now, for "3d ago" style staleness. */
function daysAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

/**
 * One line describing where the student is trying to go. Skips anything
 * blank rather than printing "– · – · –", which is what makes a summary
 * worth reading.
 */
function destinationLine(lead) {
  const intake = [lead.intake_month, lead.intake_year].filter(Boolean).join(' ');
  const parts = [lead.course_name, lead.university_name, lead.destination_country, intake]
    .map((p) => (p || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function askLine(lead) {
  const parts = [];
  if (lead.loan_amount_requested) parts.push(formatCurrency(lead.loan_amount_requested, lead.currency));
  if (lead.loan_type) parts.push(lead.loan_type);
  if (lead.admission_offer_status) parts.push(lead.admission_offer_status);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The last few calls, newest first. `timeline` is the lead_events feed the
 * drawer already loaded; call events are identified by their disposition
 * being one of CALL_STATUS_OPTIONS, which is the same list the log-call
 * form writes — so this cannot drift from what counts as a call elsewhere.
 */
function recentCalls(timeline) {
  return (timeline || [])
    .filter((e) => CALL_STATUS_OPTIONS.includes(e.event_type))
    .slice(0, HOW_MANY_CALLS);
}

function callsHtml(calls, timeline) {
  if (!calls.length) {
    const anyActivity = (timeline || []).length > 0;
    return `<p class="lead-sum-empty">${anyActivity
      ? 'No calls logged yet — the timeline has other activity.'
      : 'No calls logged yet.'}</p>`;
  }
  return `<div class="lead-sum-calls">${calls.map((c) => {
    const connected = CONNECTED_DISPOSITIONS.includes(c.event_type);
    const age = daysAgo(c.created_at);
    return `
      <div class="lead-sum-call">
        <span class="lead-sum-call-date">${escapeHtml(shortDate(c.created_at))}</span>
        <span class="lead-sum-chip ${connected ? 'ok' : 'no'}">${escapeHtml(c.event_type)}</span>
        <span class="lead-sum-call-note">${c.remarks ? escapeHtml(c.remarks) : '<span class="muted">no note</span>'}</span>
        <span class="lead-sum-call-age">${age === 0 ? 'today' : age === null ? '' : `${age}d ago`}</span>
      </div>`;
  }).join('')}</div>`;
}

/**
 * Per-lender position. Shared rows are ordered by how far the deal got, so
 * the best live outcome is the first thing read — that is the answer to
 * "can this student get funded", which a lender list sorted by name buries.
 */
function lendersHtml(rows) {
  const shared = rows.filter((r) => r.share_status === 'Shared');
  const declined = [];
  const live = [];

  shared.forEach((r) => {
    const stage = r.deals?.current_deal_stage?.name || 'Shared';
    (/(Decline|Rejected)/i.test(stage) ? declined : live).push({ ...r, stage });
  });

  const RANK = { 'Closed Won': 6, Disbursement: 5, 'PF Paid': 4, Sanction: 3, Login: 2, 'Bank Prospect': 1 };
  live.sort((a, b) => (RANK[b.stage] || 0) - (RANK[a.stage] || 0));

  const notShared = rows.filter((r) => r.share_status !== 'Shared');

  if (!shared.length) {
    return `<p class="lead-sum-empty">Not shared with any lender yet${
      notShared.length ? ` — ${notShared.length} on the list.` : '.'}</p>`;
  }

  const row = (r, cls) => `
    <div class="lead-sum-lender ${cls}">
      <span class="lead-sum-lender-name">${escapeHtml(r.lenders?.name || 'Lender')}</span>
      <span class="lead-sum-lender-stage">${escapeHtml(r.stage)}</span>
      ${r.deals?.current_deal_stage?.name && r.deals?.assigned_loan_officer?.full_name
        ? `<span class="lead-sum-lender-who">${escapeHtml(r.deals.assigned_loan_officer.full_name)}</span>` : ''}
    </div>`;

  return `
    <div class="lead-sum-lenders">
      ${live.map((r) => row(r, 'live')).join('')}
      ${declined.map((r) => row(r, 'out')).join('')}
    </div>
    <p class="lead-sum-foot">${shared.length} shared${declined.length ? ` · ${declined.length} declined` : ''}${
      notShared.length ? ` · ${notShared.length} not shared` : ''}</p>`;
}

/**
 * Renders the summary into `host`. Lender rows need one extra query, so the
 * block renders immediately with what's already known and fills the lender
 * section in when it arrives — the summary must never be the reason the
 * drawer feels slow.
 */
export async function renderLeadSummary(host, { lead, timeline, effectiveStatus }) {
  const dest = destinationLine(lead);
  const ask = askLine(lead);
  const calls = recentCalls(timeline);
  const lastActivity = daysAgo(lead.last_activity_at);
  const followUp = lead.next_follow_up_at;
  const overdue = followUp && new Date(followUp) < new Date();

  host.innerHTML = `
    <div class="lead-sum">
      <div class="lead-sum-top">
        <span class="lead-sum-status">${escapeHtml(effectiveStatus || '–')}</span>
        ${lastActivity !== null ? `<span class="lead-sum-meta">last activity ${lastActivity === 0 ? 'today' : `${lastActivity}d ago`}</span>` : ''}
        ${followUp ? `<span class="lead-sum-meta ${overdue ? 'late' : ''}">follow-up ${overdue ? 'overdue' : shortDate(followUp)}</span>` : ''}
      </div>
      ${dest ? `<div class="lead-sum-line"><span class="lead-sum-key">Going to</span><span>${escapeHtml(dest)}</span></div>` : ''}
      ${ask ? `<div class="lead-sum-line"><span class="lead-sum-key">Asking</span><span>${escapeHtml(ask)}</span></div>` : ''}

      <div class="lead-sum-block">
        <div class="lead-sum-h">Last ${HOW_MANY_CALLS} calls</div>
        ${callsHtml(calls, timeline)}
      </div>

      <div class="lead-sum-block">
        <div class="lead-sum-h">Lenders</div>
        <div data-lender-slot><p class="lead-sum-empty">Loading…</p></div>
      </div>
    </div>
  `;

  const slot = host.querySelector('[data-lender-slot]');
  try {
    slot.innerHTML = lendersHtml(await getLenderStatusForLead(lead.id));
  } catch (err) {
    // A summary failing must not look like the lead failing.
    console.error('lead summary: lender status failed', err);
    slot.innerHTML = '<p class="lead-sum-empty">Could not load lender status.</p>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
