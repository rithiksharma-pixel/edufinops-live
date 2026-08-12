// =========================================================
// SHARED UI — BD performance panel.
//
// The whole surface: date range, leaderboard, totals, downloads, and a
// BD × time-bucket trend matrix. Mounted by both the Admin Dashboard and
// the Manager Dashboard so the two read identically — the numbers differ
// only because the RPCs behind it are RLS-scoped to the caller (a Manager
// sees their team, an Admin the org). No role logic lives here.
//
// Markup uses only classes that already exist in shared/css/components.css
// plus the .bd-* additions at the bottom of that file, so it drops into
// either dashboard's card without restyling.
// =========================================================
import { escapeHtml } from './utils.js';
import { emptyState } from './emptyState.js';
import { renderTrendMatrix, renderGranularityPills } from './trendsView.js';
import {
  createBdPerformanceService, SUMMARY_COLUMNS, TREND_METRICS,
  summaryTotals, presetRange,
} from './bdPerformanceService.js';

const DELTA_LABELS = { day: 'DoD', week: 'WoW', month: 'MoM' };

const inr = (value) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
}).format(Number(value || 0));

// Compact money for trend cells, where a full ₹1,14,07,774 in every column
// would force horizontal scrolling on any realistic number of buckets.
function inrCompact(value) {
  const n = Number(value || 0);
  if (n === 0) return '0';
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

/** Minimal RFC-4180 escaping — same approach as the milestone CSV export. */
function toCsv(columns, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    columns.map((c) => esc(c.label)).join(','),
    ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(',')),
  ].join('\n');
}

function skeleton() {
  return `
    <div class="bd-toolbar">
      <div class="period-toggle" data-bd-presets>
        <button type="button" class="pill-btn" data-days="7">7d</button>
        <button type="button" class="pill-btn active" data-days="30">30d</button>
        <button type="button" class="pill-btn" data-days="90">90d</button>
        <button type="button" class="pill-btn" data-days="365">1y</button>
        <button type="button" class="pill-btn" data-days="all">Overall</button>
      </div>
      <label class="bd-daterange">From <input type="date" data-bd-from></label>
      <label class="bd-daterange">To <input type="date" data-bd-to></label>
      <button type="button" class="btn btn-secondary" data-bd-apply>Apply</button>
      <span class="bd-toolbar-spacer"></span>
      <button type="button" class="btn btn-ghost" data-bd-csv-summary>
        <i class="fa-solid fa-file-arrow-down"></i> Summary CSV
      </button>
      <button type="button" class="btn btn-ghost" data-bd-csv-detail>
        <i class="fa-solid fa-file-arrow-down"></i> Detail CSV
      </button>
    </div>

    <div data-bd-totals class="bd-totals"></div>

    <div data-bd-table>
      <div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>
    </div>

    <div class="bd-trend-section">
      <h3 class="bd-subhead">Movement over time</h3>
      <p class="bd-subnote">
        One row per BD, one column per period. Leads are counted on the day they
        were created; milestones on the date recorded against them.
      </p>
      <div class="trend-toolbar">
        <div class="period-toggle" data-bd-granularity></div>
        <select class="trend-select" data-bd-metric>
          ${TREND_METRICS.map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}
        </select>
      </div>
      <div data-bd-trend>
        <div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>
      </div>
    </div>`;
}

function renderTotals(rows) {
  const totals = summaryTotals(rows);
  const named = rows.filter((r) => !r.isUnattributed).length;
  const tiles = [
    [named, 'BD people'],
    [totals.channels, 'Channels'],
    [totals.leads, 'Leads'],
    [totals.logins, 'Logins'],
    [totals.sanctions, 'Sanctions'],
    [totals.pf_paid, 'PF paid'],
    [totals.disbursed, 'Disbursed'],
    [inr(totals.disbursed_amount), 'Disbursed ₹'],
  ];
  return tiles.map(([value, label]) => `
    <div class="bd-total-tile">
      <div class="bd-total-value">${escapeHtml(String(value))}</div>
      <div class="bd-total-label">${escapeHtml(label)}</div>
    </div>`).join('');
}

function renderTable(rows) {
  if (!rows.length) {
    return emptyState(
      'fa-handshake',
      'No BD activity in this period',
      'Leads carrying a BD name, or coming through a consultancy, will show up here.',
    );
  }
  const totals = summaryTotals(rows);

  const head = `
    <tr>
      <th class="bd-name-col">BD</th>
      ${SUMMARY_COLUMNS.map((c) => `<th${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.label)}</th>`).join('')}
    </tr>`;

  const body = rows.map((r) => {
    const cells = SUMMARY_COLUMNS.map((c) => {
      const raw = Number(r[c.key] || 0);
      return `<td class="${raw === 0 ? 'trend-zero' : ''}">${c.amount ? inr(raw) : raw}</td>`;
    }).join('');
    // The unattributed bucket is real BD business with no owner recorded —
    // shown, but visually set apart so it doesn't read as a person.
    return `
      <tr class="${r.isUnattributed ? 'bd-unattributed' : ''}">
        <td class="bd-name-col">${escapeHtml(r.displayName)}${
          r.isUnattributed
            ? ' <i class="fa-solid fa-circle-info" title="Leads from a consultancy with no BD name recorded on the lead or the consultancy"></i>'
            : ''
        }</td>
        ${cells}
      </tr>`;
  }).join('');

  const foot = `
    <tr class="trend-foot">
      <td class="bd-name-col">All BD</td>
      ${SUMMARY_COLUMNS.map((c) => `<td>${c.amount ? inr(totals[c.key]) : totals[c.key]}</td>`).join('')}
    </tr>`;

  return `<div class="trend-scroll"><table class="trend-table bd-table"><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>`;
}

/**
 * @param {object}   opts
 * @param {Element}  opts.container   Element to render into.
 * @param {object}   opts.supabase    The app's own Supabase client.
 * @param {Function} opts.showToast   (message, isError) => void
 * @param {Function} opts.downloadCsv (csvText, filename) => void
 * @returns {{refresh: Function}} refresh() re-runs the current query.
 */
export function mountBdPerformance({ container, supabase, showToast, downloadCsv }) {
  const service = createBdPerformanceService(supabase);
  container.innerHTML = skeleton();

  const $ = (sel) => container.querySelector(sel);
  const fromInput = $('[data-bd-from]');
  const toInput = $('[data-bd-to]');

  // `overall` is tracked separately from the inputs: bd_performance() takes
  // NULL bounds for all-time, which a date input cannot express.
  const state = { from: null, to: null, overall: false, granularity: 'month', metric: 'leads', rows: [] };

  function applyPreset(days) {
    if (days === 'all') {
      state.overall = true;
      // Inputs still show a concrete span, because the trend matrix below
      // always needs bounded buckets — "overall" only widens the table.
      const { from, to } = presetRange(365);
      state.from = from; state.to = to;
    } else {
      state.overall = false;
      const { from, to } = presetRange(Number(days));
      state.from = from; state.to = to;
    }
    fromInput.value = state.from;
    toInput.value = state.to;
  }

  async function renderSummary() {
    const table = $('[data-bd-table]');
    table.innerHTML = '<div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>';
    try {
      state.rows = await service.getSummary(
        state.overall ? null : state.from,
        state.overall ? null : state.to,
      );
      $('[data-bd-totals]').innerHTML = renderTotals(state.rows);
      table.innerHTML = renderTable(state.rows);
    } catch (error) {
      console.error('BD summary failed', error);
      table.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load BD performance', 'Try refreshing the page.');
    }
  }

  async function renderTrend() {
    $('[data-bd-granularity]').innerHTML = renderGranularityPills(state.granularity);
    const target = $('[data-bd-trend]');
    target.innerHTML = '<div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>';
    try {
      const metric = TREND_METRICS.find((m) => m.key === state.metric);
      const { buckets, rows } = await service.getTrend(state.from, state.to, state.granularity, state.metric);
      target.innerHTML = renderTrendMatrix({
        buckets,
        rows,
        rowLabel: 'BD',
        footLabel: 'All BD',
        deltaLabel: DELTA_LABELS[state.granularity],
        formatValue: metric?.amount ? inrCompact : (n) => n,
        emptyTitle: 'Nothing recorded in this period',
        emptyHint: 'Leads and milestones attributed to a BD will show up here.',
      });
    } catch (error) {
      console.error('BD trend failed', error);
      target.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load BD trends', 'Try refreshing the page.');
    }
  }

  async function refresh() {
    // Deliberately parallel: the two queries are independent, and the
    // leaderboard should not wait on the (heavier) series query.
    await Promise.all([renderSummary(), renderTrend()]);
  }

  function rangeLabel() {
    return state.overall ? 'all_time' : `${state.from}_to_${state.to}`;
  }

  function exportSummary() {
    if (!state.rows.length) { showToast('Nothing to export for this period.', true); return; }
    const columns = [
      { label: 'BD', value: (r) => r.displayName },
      ...SUMMARY_COLUMNS.map((c) => ({ label: c.label, value: (r) => r[c.key] })),
    ];
    downloadCsv(toCsv(columns, state.rows), `bd_performance_${rangeLabel()}.csv`);
    showToast(`Exported ${state.rows.length} BD row${state.rows.length === 1 ? '' : 's'}.`);
  }

  async function exportDetail(button) {
    button.disabled = true;
    try {
      const rows = await service.getActivityRows(
        state.overall ? null : state.from,
        state.overall ? null : state.to,
      );
      if (!rows.length) { showToast('No BD activity in that date range.', true); return; }
      const columns = [
        { label: 'BD', value: (r) => r.bd_name },
        { label: 'Attribution', value: (r) => r.bd_source },
        { label: 'Consultancy', value: (r) => r.consultancy },
        { label: 'Activity', value: (r) => r.activity },
        { label: 'Date', value: (r) => r.activity_date },
        { label: 'Amount', value: (r) => r.amount },
        { label: 'Student', value: (r) => r.student_name },
        { label: 'Phone', value: (r) => r.student_phone },
        { label: 'Lead source', value: (r) => r.lead_source },
        { label: 'Assigned RM', value: (r) => r.assigned_rm },
        { label: 'Lender', value: (r) => r.lender },
        { label: 'Lender branch', value: (r) => r.lender_branch },
      ];
      downloadCsv(toCsv(columns, rows), `bd_activity_${rangeLabel()}.csv`);
      showToast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}.`);
    } catch (error) {
      console.error('BD detail CSV failed', error);
      showToast(`Could not export: ${error.message || error}`, true);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- wiring ----------
  container.querySelector('[data-bd-presets]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-days]');
    if (!button) return;
    container.querySelectorAll('[data-bd-presets] .pill-btn').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    applyPreset(button.dataset.days);
    refresh();
  });

  $('[data-bd-apply]').addEventListener('click', () => {
    if (!fromInput.value || !toInput.value) { showToast('Pick both a From and a To date.', true); return; }
    if (fromInput.value > toInput.value) { showToast('From date must be on or before To date.', true); return; }
    // A hand-picked range is never "overall", and clearing the preset
    // highlight stops the toolbar claiming a window that is no longer shown.
    state.overall = false;
    state.from = fromInput.value;
    state.to = toInput.value;
    container.querySelectorAll('[data-bd-presets] .pill-btn').forEach((b) => b.classList.remove('active'));
    refresh();
  });

  $('[data-bd-granularity]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-granularity]');
    if (!button || button.dataset.granularity === state.granularity) return;
    state.granularity = button.dataset.granularity;
    renderTrend();
  });

  $('[data-bd-metric]').addEventListener('change', (event) => {
    state.metric = event.target.value;
    renderTrend();
  });

  $('[data-bd-csv-summary]').addEventListener('click', exportSummary);
  $('[data-bd-csv-detail]').addEventListener('click', (event) => exportDetail(event.currentTarget));

  applyPreset(30);
  refresh();

  return { refresh };
}
