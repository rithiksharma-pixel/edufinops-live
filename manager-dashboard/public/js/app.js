import { getCurrentUser } from './services/authService.js';
import { getTeamFunnel, getRmPerformance, getDailyBusiness, getLenderBreakdown, getAttentionSummary, getTatAnalysis } from './services/analyticsService.js';

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
function formatCurrency(amount) {
  if (!amount) return '₹0';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}
const emptyState = (icon, title, hint) => `<div class="empty-state-block"><div class="icon"><i class="fa-solid ${icon}"></i></div><div class="title">${escapeHtml(title)}</div><p class="hint">${escapeHtml(hint)}</p></div>`;

async function renderDailyStats() {
  const stats = await getDailyBusiness();
  document.getElementById('dailyStats').innerHTML = [
    [stats.newLeadsToday, 'New leads today', 'fa-diagram-project', 'var(--accent)'],
    [stats.disbursementsToday, 'Disbursements today', 'fa-building-columns', 'var(--accent)'],
    [formatCurrency(stats.disbursedAmountToday), 'Disbursed today', 'fa-sack-dollar', 'var(--success)'],
  ].map(([value, label, icon, accent]) => `<div class="stat-card" style="--stat-accent:${accent};"><div class="stat-icon"><i class="fa-solid ${icon}"></i></div><div class="value">${value}</div><div class="label">${label}</div></div>`).join('');
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
  const perf = await getRmPerformance();
  const tbody = document.getElementById('rmPerformanceBody');
  if (perf.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">${emptyState('fa-people-group', 'No RMs with assigned leads yet', 'Performance will show up here once leads are assigned to your team.')}</td></tr>`;
    return;
  }
  tbody.innerHTML = perf.map((rm) => `
    <tr>
      <td><strong>${escapeHtml(rm.name)}</strong></td>
      <td>${rm.leadCount}</td>
      <td>${rm.overdueCount > 0 ? `<span class="badge badge-danger">${rm.overdueCount}</span>` : '0'}</td>
      <td>${rm.dealCount}</td>
      <td>${formatCurrency(rm.disbursedAmount)}</td>
    </tr>
  `).join('');
}

async function renderAttentionList() {
  const summary = await getAttentionSummary();
  const container = document.getElementById('attentionList');
  const overdueHtml = summary.overdueLeads.slice(0, 8).map((l) =>
    `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(l.name)} <span style="color:var(--ink-500);">· ${escapeHtml(l.rm || '–')}</span></span><span class="badge badge-danger">Overdue follow-up</span></div>`
  ).join('');
  const flaggedHtml = summary.flaggedDeals.slice(0, 8).map((d) =>
    `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(d.name || '–')}</span><span class="badge badge-warning">${escapeHtml(d.reason)}</span></div>`
  ).join('');
  const overdueTasksHtml = summary.overdueTasks.slice(0, 8).map((t) =>
    `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(t.title)} <span style="color:var(--ink-500);">· ${escapeHtml(t.owner || '–')}${t.student ? ' · ' + escapeHtml(t.student) : ''}</span></span><span class="badge badge-danger">Overdue task</span></div>`
  ).join('');
  const total = summary.overdueLeads.length + summary.flaggedDeals.length + summary.overdueTasks.length;
  container.innerHTML = total === 0
    ? emptyState('fa-circle-check', 'Everything is on track', `${summary.onTrackCount} of ${summary.totalLeads} leads on track — no overdue items right now.`)
    : `<div style="margin-bottom:10px;font-size:12px;color:var(--ink-500);">${summary.onTrackCount} of ${summary.totalLeads} leads on track</div>` + overdueHtml + flaggedHtml + overdueTasksHtml;
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

  await Promise.all([renderDailyStats(), renderFunnelChart(), renderRmPerformance(), renderAttentionList(), renderLenderBreakdown(), renderTatAnalysis()]);
}

bootstrap();
