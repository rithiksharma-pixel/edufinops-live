import { getCurrentUser } from './services/authService.js';
import { getTeamFunnel, getRmPerformance, getDailyBusiness, getLenderBreakdown, getAttentionSummary } from './services/analyticsService.js';

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
function formatCurrency(amount) {
  if (!amount) return '₹0';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

async function renderDailyStats() {
  const stats = await getDailyBusiness();
  document.getElementById('dailyStats').innerHTML = `
    <div class="stat-card"><div class="value">${stats.newLeadsToday}</div><div class="label">New leads today</div></div>
    <div class="stat-card"><div class="value">${stats.disbursementsToday}</div><div class="label">Disbursements today</div></div>
    <div class="stat-card"><div class="value">${formatCurrency(stats.disbursedAmountToday)}</div><div class="label">Disbursed today</div></div>
  `;
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
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No RMs with assigned leads yet.</td></tr>';
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
  const total = summary.overdueLeads.length + summary.flaggedDeals.length;
  container.innerHTML = total === 0
    ? `<p class="empty-state">Nothing needs attention — ${summary.onTrackCount} of ${summary.totalLeads} leads on track.</p>`
    : `<div style="margin-bottom:10px;font-size:12px;color:var(--ink-500);">${summary.onTrackCount} of ${summary.totalLeads} leads on track</div>` + overdueHtml + flaggedHtml;
}

async function renderLenderBreakdown() {
  const breakdown = await getLenderBreakdown();
  const container = document.getElementById('lenderBreakdown');
  if (breakdown.length === 0) {
    container.innerHTML = '<p class="empty-state">No deals shared with any lender yet.</p>';
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

async function bootstrap() {
  let user;
  try {
    user = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">Please sign in first.</div>';
    return;
  }
  document.getElementById('userName').textContent = user.fullName;
  document.getElementById('avatar').textContent = user.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  await Promise.all([renderDailyStats(), renderFunnelChart(), renderRmPerformance(), renderAttentionList(), renderLenderBreakdown()]);
}

bootstrap();
