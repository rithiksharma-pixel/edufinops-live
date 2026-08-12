import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { presetRange } from '../../../shared/js/dateBuckets.js';
import { getMyPerformance, getMyStageBreakdown } from './services/reportService.js';
import { listMyLeads } from './services/leadService.js';
import { formatCurrency, formatDateTime } from './utils/validation.js';

// `overall` is tracked separately from the dates because source_performance()
// takes NULL bounds for all time, which a date range cannot express.
const state = { from: null, to: null, overall: true };

function applyPreset(days) {
  if (days === 'all') {
    state.overall = true;
    state.from = null;
    state.to = null;
    return;
  }
  const { from, to } = presetRange(Number(days));
  state.overall = false;
  state.from = from;
  state.to = to;
}

function tile(value, label, accent) {
  return `<div class="bd-total-tile">
    <div class="bd-total-value"${accent ? ` style="color:${accent};"` : ''}>${escapeHtml(String(value))}</div>
    <div class="bd-total-label">${escapeHtml(label)}</div>
  </div>`;
}

async function renderTotals() {
  const target = document.getElementById('cpTotals');
  try {
    const p = await getMyPerformance(state.from, state.to);
    target.innerHTML = `<div class="bd-totals">
      ${tile(p.students_submitted ?? 0, 'Students submitted')}
      ${tile(p.students_active ?? 0, 'Still in progress')}
      ${tile(p.shared_with_lender ?? 0, 'Sent to a bank')}
      ${tile(p.logins ?? 0, 'Logged in')}
      ${tile(p.sanctions ?? 0, 'Sanctioned', 'var(--success)')}
      ${tile(formatCurrency(p.sanctioned_amount ?? 0), 'Sanctioned value')}
      ${tile(p.disbursed ?? 0, 'Disbursed', 'var(--success)')}
      ${tile(formatCurrency(p.disbursed_amount ?? 0), 'Disbursed value')}
    </div>`;
  } catch (err) {
    console.error('consultant performance failed', err);
    target.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load your numbers', 'Try refreshing the page.');
  }
}

async function renderStages() {
  const target = document.getElementById('cpStages');
  try {
    const stages = await getMyStageBreakdown(state.from, state.to);
    const total = stages.reduce((sum, s) => sum + Number(s.student_count || 0), 0);
    if (total === 0) {
      target.innerHTML = emptyState('fa-user-graduate', 'No students in this period', 'Submit a student and their progress will show up here.');
      return;
    }
    const largest = Math.max(1, ...stages.map((s) => Number(s.student_count || 0)));
    target.innerHTML = stages.map((s) => {
      const count = Number(s.student_count || 0);
      return `<div style="margin-bottom:11px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
          <span>${escapeHtml(s.stage_name)}</span>
          <span style="font-family:var(--font-mono);${count === 0 ? 'color:var(--ink-300);' : ''}">${count}</span>
        </div>
        <div style="background:var(--bg-hover);border-radius:4px;height:8px;">
          <div style="background:var(--accent);width:${(count / largest) * 100}%;height:100%;border-radius:4px;"></div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('consultant stage breakdown failed', err);
    target.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load your stages', 'Try refreshing the page.');
  }
}

/**
 * Exports the consultant's own students. Sourced from listMyLeads() — the
 * same RLS-scoped query the My Students table uses — so the download and
 * the screen can never disagree.
 */
async function exportCsv(button) {
  button.disabled = true;
  try {
    const leads = await listMyLeads();
    const rows = state.overall
      ? leads
      : leads.filter((l) => {
          const d = new Date(l.created_at);
          const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return iso >= state.from && iso <= state.to;
        });
    if (!rows.length) { showToast('No students in this period.', true); return; }

    const cols = [
      ['Student', (l) => l.student_name],
      ['Phone', (l) => l.student_phone],
      ['Course', (l) => l.course_name],
      ['University', (l) => l.university_name],
      ['Loan amount', (l) => l.loan_amount_requested],
      ['Stage', (l) => l.lead_stages?.name],
      ['Submitted', (l) => formatDateTime(l.created_at)],
    ];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      cols.map(([label]) => esc(label)).join(','),
      ...rows.map((l) => cols.map(([, get]) => esc(get(l))).join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my_students_${state.overall ? 'all_time' : `${state.from}_to_${state.to}`}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} student${rows.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error('consultant CSV failed', err);
    showToast(`Could not export: ${err.message || err}`, true);
  } finally {
    button.disabled = false;
  }
}

function refresh() {
  return Promise.all([renderTotals(), renderStages()]);
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
  mountTopbar({ app: 'consultant-portal', user });
  setBreadcrumb(['My Report']);

  document.getElementById('cpPresets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-days]');
    if (!button) return;
    document.querySelectorAll('#cpPresets .pill-btn').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    applyPreset(button.dataset.days);
    refresh();
  });
  document.getElementById('cpCsv').addEventListener('click', (event) => exportCsv(event.currentTarget));

  applyPreset('all');
  await refresh();
}

guardBootstrap(bootstrap, 'My Report');
