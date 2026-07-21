import { getCurrentUser } from './services/authService.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import { getTeamFunnel, getRmPerformance, getRmCallStats, getDailyBusiness, getLenderBreakdown, getAttentionSummary, getTatAnalysis } from './services/analyticsService.js';
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
import { assignLeadToRm } from '../../../lead-management/public/js/services/leadService.js';
import { getAssignableRms } from '../../../lead-management/public/js/services/lookupService.js';
import { initLeadDrawer } from '../../../lead-management/public/js/components/leadDrawer.js';

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

async function renderRmPerformance() {
  const [perf, callStats] = await Promise.all([getRmPerformance(), getRmCallStats()]);
  const tbody = document.getElementById('rmPerformanceBody');
  if (perf.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyState('fa-people-group', 'No RMs with assigned leads yet', 'Performance will show up here once leads are assigned to your team.')}</td></tr>`;
    return;
  }
  tbody.innerHTML = perf.map((rm) => {
    const calls = callStats[rm.id] || { callCount: 0, connectedCount: 0 };
    const connectRate = calls.callCount > 0 ? `${Math.round((calls.connectedCount / calls.callCount) * 100)}%` : '–';
    return `
    <tr data-rm-id="${rm.id}" style="cursor:pointer;" title="Open ${escapeHtml(rm.name)}'s leads in Lead Management">
      <td><strong>${escapeHtml(rm.name)}</strong></td>
      <td>${rm.leadCount}</td>
      <td>${rm.overdueCount > 0 ? `<span class="badge badge-danger">${rm.overdueCount}</span>` : '0'}</td>
      <td>${rm.dealCount}</td>
      <td>${formatCurrency(rm.disbursedAmount)}</td>
      <td>${calls.callCount}</td>
      <td>${connectRate}</td>
    </tr>
  `;
  }).join('');

  // An RM row is an aggregate (many leads), not one lead — opens the full
  // filtered list in Lead Management (new tab, so the dashboard stays put)
  // rather than the single-lead drawer.
  tbody.querySelectorAll('[data-rm-id]').forEach((row) => {
    row.addEventListener('click', () => {
      window.open(`../../lead-management/public/index.html?rmId=${row.dataset.rmId}`, '_blank');
    });
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
    tbody.innerHTML = `<tr><td colspan="5">${emptyState('fa-circle-check', 'All caught up', 'Every new lead has been handed off to an RM.')}</td></tr>`;
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
}

async function renderAttentionList() {
  const summary = await getAttentionSummary();
  const container = document.getElementById('attentionList');
  const rowAttr = (leadId) => (leadId ? ` data-lead-id="${leadId}" style="cursor:pointer;"` : ' style=""');
  const overdueHtml = summary.overdueLeads.slice(0, 8).map((l) =>
    `<div${rowAttr(l.leadId)} style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(l.name)} <span style="color:var(--ink-500);">· ${escapeHtml(l.rm || '–')}</span></span><span class="badge badge-danger">Overdue follow-up</span></div>`
  ).join('');
  const flaggedHtml = summary.flaggedDeals.slice(0, 8).map((d) =>
    `<div${rowAttr(d.leadId)} style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(d.name || '–')}</span><span class="badge badge-warning">${escapeHtml(d.reason)}</span></div>`
  ).join('');
  const overdueTasksHtml = summary.overdueTasks.slice(0, 8).map((t) =>
    `<div${rowAttr(t.leadId)} style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(t.title)} <span style="color:var(--ink-500);">· ${escapeHtml(t.owner || '–')}${t.student ? ' · ' + escapeHtml(t.student) : ''}</span></span><span class="badge badge-danger">Overdue task</span></div>`
  ).join('');
  const total = summary.overdueLeads.length + summary.flaggedDeals.length + summary.overdueTasks.length;
  container.innerHTML = total === 0
    ? emptyState('fa-circle-check', 'Everything is on track', `${summary.onTrackCount} of ${summary.totalLeads} leads on track — no overdue items right now.`)
    : `<div style="margin-bottom:10px;font-size:12px;color:var(--ink-500);">${summary.onTrackCount} of ${summary.totalLeads} leads on track</div>` + overdueHtml + flaggedHtml + overdueTasksHtml;
  container.querySelectorAll('[data-lead-id]').forEach((row) => {
    row.addEventListener('click', () => leadDrawer.open(row.dataset.leadId));
  });
}

async function renderLenderBreakdown() {
  const breakdown = await getLenderBreakdown();
  const container = document.getElementById('lenderBreakdown');
  if (breakdown.length === 0) {
    container.innerHTML = emptyState('fa-building-columns', 'No lender deals yet', 'Once a deal is shared with a lender, its progress will break down here.');
    return;
  }
  container.innerHTML = breakdown.map((lender) => {
    const stagesText = Object.entries(lender.stageCounts).map(([name, count]) => `${escapeHtml(name)}: ${count}`).join(' · ');
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:500;"><span>${escapeHtml(lender.name)}</span><span class="amount">${lender.dealCount} deals</span></div>
      <div style="font-size:12px;color:var(--ink-500);margin-top:2px;">${stagesText}</div>
      ${lender.disbursedAmount > 0 ? `<div style="font-size:12px;color:var(--success);margin-top:2px;">${formatCurrency(lender.disbursedAmount)} disbursed</div>` : ''}
    </div>`;
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

async function bootstrap() {
  let user;
  try {
    user = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-right-to-bracket" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Sign-in required</strong><span style="color:var(--ink-500);font-size:13px;">Please <a href="../../authentication/public/login.html" style="color:var(--accent);">sign in</a> first.</span></div>';
    return;
  }
  document.getElementById('userName').textContent = user.fullName;
  document.getElementById('avatar').textContent = user.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  mountTopbar({ app: 'manager-dashboard', user });

  leadDrawer = initLeadDrawer({
    showToast,
    onLeadUpdated: () => Promise.all([renderAttentionList(), renderRmPerformance()]),
    currentUser: user,
  });

  initTrendControls();
  await populateTrendLenders();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.__closeLeadDrawer) window.__closeLeadDrawer();
  });

  await Promise.all([renderDailyStats(), renderUnassignedLeads(), renderFunnelChart(), renderRmPerformance(), renderAttentionList(), renderLenderBreakdown(), renderTatAnalysis(), renderLeadTrends(), renderDealTrends()]);
}

bootstrap();
