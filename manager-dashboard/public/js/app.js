import { getCurrentUser } from './services/authService.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import { getTeamFunnel, getRmPerformance, getRmCallStats, getDailyBusiness, getLenderBreakdown, getTatAnalysis, PERF_GROUPS, periodRange } from './services/analyticsService.js';
import { getUnassignedLeads } from './services/unassignedLeadsService.js';
import { createTrendsService } from '../../../shared/js/trendsService.js';
import { renderTrendMatrix, renderGranularityPills } from '../../../shared/js/trendsView.js';
import { supabase } from './config/supabaseClient.js';
// Cross-app imports: app folders are top-level siblings (not nested), so
// this reaches lead-management's own service layer three levels up. These
// are the SAME functions Lead Management's own UI calls — assignLeadToRm
// already has the correct RLS/audit-trail behavior (writes lead_assignments
// + lead_events), and getAssignableRms is already scoped to "my team" by
// the users table's own RLS. Nothing new is reimplemented here.
import { assignLeadToRm, assignLeadsBulk } from '../../../lead-management/public/js/services/leadService.js';
import { getAssignableRms } from '../../../lead-management/public/js/services/lookupService.js';
import { initLeadDrawer } from '../../../lead-management/public/js/components/leadDrawer.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { getMilestoneCounts, getMilestoneRows } from './services/milestoneService.js';
import { downloadCsv } from '../../../authentication/public/js/services/exportImportService.js';

let leadDrawer;

const UNASSIGNED_WARNING_MS = 48 * 60 * 60 * 1000; // 48h — flagged with a warning badge

function formatCurrency(amount) {
  if (!amount) return '₹0';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}
async function renderDailyStats() {
  const stats = await getDailyBusiness();
  // Only "New leads today" has an honest drill-down target — the other
  // two are deal-level counts, and Lead Management's list is leads-only.
  document.getElementById('dailyStats').innerHTML = [
    [stats.newLeadsToday, 'New leads today', 'fa-diagram-project', 'var(--accent)', true],
    [stats.disbursementsToday, 'Disbursements today', 'fa-building-columns', 'var(--accent)', false],
    [formatCurrency(stats.disbursedAmountToday), 'Disbursed today', 'fa-sack-dollar', 'var(--success)', false],
  ].map(([value, label, icon, accent, clickable]) => `<div class="stat-card"${clickable ? ' data-goto-leads-today' : ''} style="--stat-accent:${accent};${clickable ? 'cursor:pointer;' : ''}"><div class="stat-icon"><i class="fa-solid ${icon}"></i></div><div class="value">${value}</div><div class="label">${label}</div></div>`).join('');
  document.querySelectorAll('#dailyStats [data-goto-leads-today]').forEach((card) => {
    card.addEventListener('click', () => {
      const today = new Date().toISOString().slice(0, 10);
      window.open(`../../lead-management/public/index.html?dateField=created_at&dateFrom=${today}&dateTo=${today}`, '_blank');
    });
  });
}

async function renderFunnelChart() {
  const funnel = await getTeamFunnel();
  new Chart(document.getElementById('funnelChart'), {
    type: 'bar',
    data: {
      labels: funnel.map((f) => f.name),
      datasets: [{ label: 'Leads', data: funnel.map((f) => f.count), backgroundColor: '#4F46E5', borderRadius: 4 }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

const perfState = { period: 'all', groupBy: 'owner', rows: [] };

async function renderRmPerformance() {
  const tbody = document.getElementById('rmPerformanceBody');
  const { from, to } = periodRange(perfState.period);

  // Call stats are per USER, so they only line up when grouping by owner.
  // Showing one RM's call count against a whole team's row would be a lie,
  // so those two columns blank out for team/manager rather than mislead.
  const byOwner = perfState.groupBy === 'owner';
  let perf; let callStats = {};
  try {
    [perf, callStats] = await Promise.all([
      getRmPerformance(from, to, perfState.groupBy),
      byOwner ? getRmCallStats() : Promise.resolve({}),
    ]);
  } catch (err) {
    console.error('performance failed', err);
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state">Could not load performance.<br>
      <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span></td></tr>`;
    return;
  }

  perfState.rows = perf;
  document.getElementById('perfGroupHeader').textContent = PERF_GROUPS[perfState.groupBy];

  if (perf.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12">${emptyState('fa-people-group', 'Nothing in this period', 'Try a wider period, or check that leads are assigned.')}</td></tr>`;
    return;
  }

  const n = (v) => Number(v || 0).toLocaleString('en-IN');
  tbody.innerHTML = perf.map((r) => {
    const calls = callStats[r.id] || { callCount: 0, connectedCount: 0 };
    const connectRate = calls.callCount > 0 ? `${Math.round((calls.connectedCount / calls.callCount) * 100)}%` : '–';
    return `
    <tr ${byOwner ? `data-rm-id="${r.id}" style="cursor:pointer;" title="Open ${escapeHtml(r.name)}'s leads in Lead Management"` : ''}>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td class="num">${n(r.leadCount)}</td>
      <td class="num">${n(r.logins)}</td>
      <td class="num">${n(r.sanctions)}</td>
      <td class="num">${n(r.pf)}</td>
      <td class="num">${n(r.disbursed)}</td>
      <td class="num">${r.disbursedAmount ? formatCurrency(r.disbursedAmount) : '–'}</td>
      <td class="num">${n(r.referrals)}</td>
      <td class="num">${n(r.pfFromReferrals)}</td>
      <td class="num">${r.overdueCount > 0 ? `<span class="badge badge-danger">${n(r.overdueCount)}</span>` : '0'}</td>
      <td class="num">${byOwner ? n(calls.callCount) : '–'}</td>
      <td class="num">${byOwner ? connectRate : '–'}</td>
    </tr>`;
  }).join('');

  // A row is an aggregate (many leads), not one lead — opens the filtered list
  // in Lead Management in a new tab rather than the single-lead drawer. Only
  // meaningful per owner, since that is the filter Lead Management accepts.
  tbody.querySelectorAll('[data-rm-id]').forEach((row) => {
    row.addEventListener('click', () => {
      window.open(`../../lead-management/public/index.html?rmId=${row.dataset.rmId}`, '_blank');
    });
  });
}

function wirePerformanceControls() {
  const pills = document.getElementById('perfPeriod');
  pills?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    pills.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    perfState.period = btn.dataset.period;
    renderRmPerformance();
  });

  document.getElementById('perfGroupBy')?.addEventListener('change', (e) => {
    perfState.groupBy = e.target.value;
    renderRmPerformance();
  });

  document.getElementById('btnPerfCsv')?.addEventListener('click', () => {
    const cols = [
      [PERF_GROUPS[perfState.groupBy], (r) => r.name],
      ['Leads', (r) => r.leadCount], ['Logins', (r) => r.logins],
      ['Sanctions', (r) => r.sanctions], ['PF', (r) => r.pf],
      ['Disbursed', (r) => r.disbursed], ['Disbursed value', (r) => r.disbursedAmount],
      ['Referrals', (r) => r.referrals], ['PF from referrals', (r) => r.pfFromReferrals],
      ['Overdue follow-ups', (r) => r.overdueCount],
    ];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.map((c) => esc(c[0])).join(',')]
      .concat(perfState.rows.map((r) => cols.map((c) => esc(c[1](r))).join(',')))
      .join('\n');
    downloadCsv(csv, `performance-${perfState.groupBy}-${perfState.period}.csv`);
    showToast(`Exported ${perfState.rows.length} rows`);
  });
}


function formatWaiting(iso) {
  const hours = (Date.now() - new Date(iso).getTime()) / (60 * 60 * 1000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function leadSourceLabel(lead) {
  const consultancyName = lead.consultancies?.name || lead.consultancy_other_name;
  const sourceName = lead.lead_sources?.name;
  if (sourceName && consultancyName) return `${sourceName} · ${consultancyName}`;
  return sourceName || consultancyName || '–';
}

async function renderUnassignedLeads() {
  const tbody = document.getElementById('unassignedLeadsBody');
  const countBadge = document.getElementById('unassignedOverdueBadge');
  const [leads, rms] = await Promise.all([getUnassignedLeads(), getAssignableRms()]);

  const overdueCount = leads.filter((l) => Date.now() - new Date(l.created_at).getTime() > UNASSIGNED_WARNING_MS).length;
  if (overdueCount > 0) {
    countBadge.hidden = false;
    countBadge.textContent = `${overdueCount} waiting over 48h`;
  } else {
    countBadge.hidden = true;
  }

  if (leads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">${emptyState('fa-circle-check', 'All caught up', 'Every new lead has been handed off to an RM.')}</td></tr>`;
    document.getElementById('unassignedBulkBar').hidden = true;
    return;
  }

  const rmOptions = rms.map((rm) => `<option value="${rm.id}">${escapeHtml(rm.full_name)}</option>`).join('');

  tbody.innerHTML = leads.map((l) => {
    const overdue = Date.now() - new Date(l.created_at).getTime() > UNASSIGNED_WARNING_MS;
    const waitingCell = overdue
      ? `<span class="badge badge-warning">${escapeHtml(formatWaiting(l.created_at))}</span>`
      : escapeHtml(formatWaiting(l.created_at));
    return `
    <tr>
      <td><input type="checkbox" class="bulk-check" data-lead-id="${l.id}" aria-label="Select ${escapeHtml(l.student_name)}" /></td>
      <td><strong>${escapeHtml(l.student_name)}</strong></td>
      <td>${escapeHtml(leadSourceLabel(l))}</td>
      <td class="amount">${formatCurrency(l.loan_amount_requested)}</td>
      <td>${waitingCell}</td>
      <td>
        <div style="display:flex;gap:6px;align-items:center;">
          <select class="unassigned-rm-select" data-lead-id="${l.id}" style="padding:6px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);font-size:13px;max-width:150px;">
            <option value="">Assign to…</option>
            ${rmOptions}
          </select>
          <button type="button" class="btn btn-primary" data-assign-btn data-lead-id="${l.id}" disabled style="padding:6px 12px;font-size:13px;">Assign</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.unassigned-rm-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const btn = tbody.querySelector(`[data-assign-btn][data-lead-id="${e.target.dataset.leadId}"]`);
      if (btn) btn.disabled = !e.target.value;
    });
  });

  tbody.querySelectorAll('[data-assign-btn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const leadId = btn.dataset.leadId;
      const select = tbody.querySelector(`.unassigned-rm-select[data-lead-id="${leadId}"]`);
      const newRmId = select?.value;
      if (!newRmId) return;
      btn.disabled = true;
      select.disabled = true;
      btn.textContent = 'Assigning…';
      try {
        await assignLeadToRm(leadId, newRmId, 'Assigned from Manager Dashboard – Unassigned Leads');
        showToast('Lead assigned.');
        await renderUnassignedLeads();
      } catch (err) {
        console.error(err);
        showToast('Could not assign this lead. Please try again.', true);
        btn.disabled = false;
        select.disabled = false;
        btn.textContent = 'Assign';
      }
    });
  });

  wireBulkAssign(tbody, rmOptions);
}

/**
 * Bulk assign. One assign_leads_bulk() call rather than a loop of single
 * assigns from the browser — 385 sequential round trips would take minutes and
 * leave a half-assigned queue if the tab closed. The RPC still calls
 * assign_lead() per row internally, so every lead keeps its lead_assignments
 * row and its 'Reassigned' timeline event.
 */
function wireBulkAssign(tbody, rmOptions) {
  const bar = document.getElementById('unassignedBulkBar');
  const countEl = document.getElementById('bulkCount');
  const select = document.getElementById('bulkRmSelect');
  const selectAll = document.getElementById('bulkSelectAll');
  if (!bar || !select) return;

  if (select.options.length <= 1) {
    select.insertAdjacentHTML('beforeend', rmOptions);
  }

  const checks = () => [...tbody.querySelectorAll('.bulk-check')];
  const selected = () => checks().filter((c) => c.checked).map((c) => c.dataset.leadId);

  function sync() {
    const ids = selected();
    bar.hidden = ids.length === 0;
    countEl.textContent = `${ids.length} selected`;
    if (selectAll) {
      selectAll.checked = ids.length > 0 && ids.length === checks().length;
      selectAll.indeterminate = ids.length > 0 && ids.length < checks().length;
    }
  }

  checks().forEach((c) => c.addEventListener('change', sync));
  selectAll?.addEventListener('change', () => {
    checks().forEach((c) => { c.checked = selectAll.checked; });
    sync();
  });
  document.getElementById('btnBulkClear')?.addEventListener('click', () => {
    checks().forEach((c) => { c.checked = false; });
    sync();
  });

  const btn = document.getElementById('btnBulkAssign');
  btn?.addEventListener('click', async () => {
    const ids = selected();
    const rmId = select.value;
    if (!ids.length) return;
    if (!rmId) { showToast('Choose who to assign these to.', true); return; }

    const name = select.options[select.selectedIndex]?.text || 'that RM';
    // Reassigning someone else's book is not obviously reversible, so make the
    // scale of it explicit before it happens.
    if (!window.confirm(`Assign ${ids.length} lead${ids.length === 1 ? '' : 's'} to ${name}?`)) return;

    btn.disabled = true;
    btn.textContent = 'Assigning…';
    try {
      const count = await assignLeadsBulk(ids, rmId, 'Bulk assigned from Manager Dashboard');
      showToast(`${count} lead${count === 1 ? '' : 's'} assigned to ${name}.`);
      await renderUnassignedLeads();
    } catch (err) {
      console.error('bulk assign failed', err);
      showToast(err?.message || 'Could not assign those leads.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Assign';
    }
  });

  sync();
}

/**
 * Deals per lender, as a table rather than a run-on line of "Login: 125 ·
 * Bank Prospect: 9 · ...". Fixed columns in pipeline order mean you can read
 * DOWN a column to compare banks at the same stage, which is the actual
 * question — the old text list made that impossible because every lender
 * listed its stages in a different order.
 */
const LENDER_STAGE_COLUMNS = ['Bank Prospect', 'Login', 'Sanction', 'PF Paid', 'Disbursement'];

async function renderLenderBreakdown() {
  const tbody = document.getElementById('lenderBreakdown');
  let breakdown;
  try {
    breakdown = await getLenderBreakdown();
  } catch (err) {
    console.error('lender breakdown failed', err);
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">Could not load lender deals.<br>
      <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span></td></tr>`;
    return;
  }
  if (!breakdown.length) {
    tbody.innerHTML = `<tr><td colspan="9">${emptyState('fa-building-columns', 'No lender deals yet', 'Once a deal is shared with a lender, its progress will break down here.')}</td></tr>`;
    return;
  }

  const n = (v) => (v ? Number(v).toLocaleString('en-IN') : '–');
  tbody.innerHTML = breakdown.map((l) => {
    const c = l.stageCounts || {};
    // Credit Decline and Student Decline are both "the bank said no" for this
    // view; splitting them across two columns of mostly zeros helps nobody.
    const declined = (c['Credit Decline'] || 0) + (c['Student Decline'] || 0);
    return `<tr>
      <td><strong>${escapeHtml(l.name)}</strong></td>
      ${LENDER_STAGE_COLUMNS.map((stage) => `<td class="num">${n(c[stage])}</td>`).join('')}
      <td class="num">${declined ? `<span class="badge badge-danger">${n(declined)}</span>` : '–'}</td>
      <td class="num"><strong>${n(l.dealCount)}</strong></td>
      <td class="num">${l.disbursedAmount > 0 ? formatCurrency(l.disbursedAmount) : '–'}</td>
    </tr>`;
  }).join('');
}

async function renderTatAnalysis() {
  const { averages, worstOffenders } = await getTatAnalysis();

  document.getElementById('tatAverages').innerHTML = averages.length
    ? averages.map((t) => `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;"><span>${escapeHtml(t.label)}</span><span class="amount">${t.avgDays.toFixed(1)}d avg · ${t.count} deal${t.count === 1 ? '' : 's'}</span></div>
        </div>`).join('')
    : emptyState('fa-hourglass-half', 'No stage transitions yet', 'TAT averages will appear once deals start moving between stages.');

  document.getElementById('tatWorstOffenders').innerHTML = worstOffenders.length
    ? worstOffenders.map((t) => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
          <span>${escapeHtml(t.student || '–')} <span style="color:var(--ink-500);">· ${escapeHtml(t.label)}</span></span>
          <span class="badge badge-warning">${t.days.toFixed(1)}d</span>
        </div>
        ${t.remarks ? `<div style="font-size:12px;color:var(--ink-500);padding:0 0 6px;">${escapeHtml(t.remarks)}</div>` : ''}`).join('')
    : '<p class="empty-state">No stage transitions recorded yet.</p>';
}

// ---------- Stage movement trends (lead + bank-wise deal) ----------
const trends = createTrendsService(supabase);
const trendState = { lead: 'day', deal: 'day', lenderId: '' };
const DELTA_LABELS = { day: 'DoD', week: 'WoW', month: 'MoM' };

async function renderLeadTrends() {
  const host = document.getElementById('leadTrendMatrix');
  document.getElementById('leadTrendPills').innerHTML = renderGranularityPills(trendState.lead);
  try {
    const { buckets, rows } = await trends.getLeadStageTrends(trendState.lead);
    host.innerHTML = renderTrendMatrix({ buckets, rows, deltaLabel: DELTA_LABELS[trendState.lead] });
  } catch (err) {
    console.error(err);
    host.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load lead trends', 'Try refreshing the page.');
  }
}

async function renderDealTrends() {
  const host = document.getElementById('dealTrendMatrix');
  document.getElementById('dealTrendPills').innerHTML = renderGranularityPills(trendState.deal);
  try {
    const { buckets, rows } = await trends.getDealStageTrends(trendState.deal, trendState.lenderId || null);
    host.innerHTML = renderTrendMatrix({ buckets, rows, deltaLabel: DELTA_LABELS[trendState.deal] });
  } catch (err) {
    console.error(err);
    host.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load deal trends', 'Try refreshing the page.');
  }
}

function initTrendControls() {
  document.getElementById('leadTrendPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-granularity]');
    if (!btn || btn.dataset.granularity === trendState.lead) return;
    trendState.lead = btn.dataset.granularity;
    renderLeadTrends();
  });
  document.getElementById('dealTrendPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-granularity]');
    if (!btn || btn.dataset.granularity === trendState.deal) return;
    trendState.deal = btn.dataset.granularity;
    renderDealTrends();
  });
  document.getElementById('dealTrendLender').addEventListener('change', (e) => {
    trendState.lenderId = e.target.value;
    renderDealTrends();
  });
}

async function populateTrendLenders() {
  try {
    const lenders = await trends.getTrendLenders();
    document.getElementById('dealTrendLender').insertAdjacentHTML(
      'beforeend',
      lenders.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')
    );
  } catch (err) {
    console.error(err);
  }
}

/* ---------- Milestone counts by date range ---------- */

const MILESTONE_META = {
  Login:        { icon: 'fa-right-to-bracket', accent: 'var(--accent)' },
  Sanction:     { icon: 'fa-stamp',            accent: 'var(--success)' },
  'PF Paid':    { icon: 'fa-sack-dollar',      accent: 'var(--warning)' },
  Disbursement: { icon: 'fa-money-bill-transfer', accent: 'var(--success)' },
};

const isoDay = (d) => d.toISOString().slice(0, 10);

function currentMilestoneRange() {
  return { from: document.getElementById('milestoneFrom').value, to: document.getElementById('milestoneTo').value };
}

function setMilestoneRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  document.getElementById('milestoneFrom').value = isoDay(from);
  document.getElementById('milestoneTo').value = isoDay(to);
}

async function renderMilestoneCounts() {
  const host = document.getElementById('milestoneCounts');
  const { from, to } = currentMilestoneRange();
  if (!from || !to) return;
  if (from > to) {
    host.innerHTML = `<p class="empty-state">"From" is after "To" — swap the dates to see results.</p>`;
    return;
  }
  host.innerHTML = '<div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>';
  try {
    const rows = await getMilestoneCounts(from, to);
    host.innerHTML = `<div class="milestone-grid">${rows.map((r) => {
      const meta = MILESTONE_META[r.milestone] || { icon: 'fa-circle-dot', accent: 'var(--accent)' };
      return `<div class="milestone-card" style="--stat-accent:${meta.accent}">
        <div class="stat-icon"><i class="fa-solid ${meta.icon}"></i></div>
        <div class="milestone-count">${r.deal_count}</div>
        <div class="milestone-label">${escapeHtml(r.milestone)}</div>
        <div class="milestone-value">${r.total_amount > 0 ? formatCurrency(r.total_amount) : '—'}</div>
      </div>`;
    }).join('')}</div>`;
  } catch (err) {
    console.error('milestone counts failed', err);
    host.innerHTML = `<p class="empty-state">Could not load milestone counts: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

async function exportMilestonesCsv() {
  const { from, to } = currentMilestoneRange();
  const btn = document.getElementById('btnMilestoneCsv');
  btn.disabled = true;
  try {
    const rows = await getMilestoneRows(from, to);
    if (!rows.length) { showToast('No milestones in that date range.', true); return; }
    const cols = ['event_date', 'milestone', 'student_name', 'student_phone', 'lender', 'lender_branch', 'assigned_rm', 'team', 'lead_source', 'amount', 'reference'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    downloadCsv(csv, `milestones_${from}_to_${to}.csv`);
    showToast(`Exported ${rows.length} milestone${rows.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error('milestone CSV failed', err);
    showToast(`Could not export: ${err.message || err}`, true);
  } finally {
    btn.disabled = false;
  }
}

function initMilestoneControls() {
  setMilestoneRange(30); // default view: last 30 days
  document.getElementById('btnMilestoneApply').addEventListener('click', () => {
    document.querySelectorAll('#milestonePresets button').forEach((b) => b.classList.remove('active'));
    renderMilestoneCounts();
  });
  document.getElementById('btnMilestoneCsv').addEventListener('click', exportMilestonesCsv);
  document.querySelectorAll('#milestonePresets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#milestonePresets button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setMilestoneRange(Number(btn.dataset.days));
      renderMilestoneCounts();
    });
  });
}

async function bootstrap() {
  let user;
  try {
    user = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-right-to-bracket" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Sign-in required</strong><span style="color:var(--ink-500);font-size:13px;">Please <a href="../../authentication/public/login.html" style="color:var(--accent);">sign in</a> first.</span></div>';
    return;
  }
  document.getElementById('userName').textContent = user.fullName;
  document.getElementById('userRole').textContent = user.role;
  document.getElementById('avatar').textContent = user.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  mountTopbar({ app: 'manager-dashboard', user });

  leadDrawer = initLeadDrawer({
    showToast,
    onLeadUpdated: () => renderRmPerformance(),
    currentUser: user,
  });

  initTrendControls();
  initMilestoneControls();
  await populateTrendLenders();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.__closeLeadDrawer) window.__closeLeadDrawer();
  });

  wirePerformanceControls();
  await Promise.all([renderDailyStats(), renderMilestoneCounts(), renderUnassignedLeads(), renderFunnelChart(), renderRmPerformance(), renderLenderBreakdown(), renderTatAnalysis(), renderLeadTrends(), renderDealTrends()]);
}

guardBootstrap(bootstrap, 'Manager Dashboard');