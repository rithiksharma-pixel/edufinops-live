// =========================================================
// SHARED UI — stage-movement trend matrix (stage rows × time buckets).
// Used by Manager and Admin dashboards for both lead-stage and
// deal-stage trends, so the two read identically.
// Styles live in shared/css/components.css (.trend-*).
// =========================================================
import { escapeHtml } from './utils.js';
import { emptyState } from './emptyState.js';

/**
 * Δ between the last two buckets — the "month on month" (or week/day)
 * movement. Returns null when there's no prior bucket to compare against.
 */
function deltaFor(counts, buckets) {
  if (buckets.length < 2) return null;
  const latest = counts[buckets[buckets.length - 1].key] || 0;
  const prev = counts[buckets[buckets.length - 2].key] || 0;
  return latest - prev;
}

function deltaCell(delta, format) {
  if (delta === null) return '<td class="trend-delta">–</td>';
  if (delta === 0) return '<td class="trend-delta"><span class="trend-flat">0</span></td>';
  const up = delta > 0;
  return `<td class="trend-delta"><span class="${up ? 'trend-up' : 'trend-down'}">${up ? '▲' : '▼'} ${format(Math.abs(delta))}</span></td>`;
}

/**
 * @param {object}   data
 * @param {Array}    data.buckets
 * @param {Array<{label,counts,total}>} data.rows
 * @param {string}   [data.deltaLabel='Δ']
 * @param {string}   [data.rowLabel='Stage']  Header above the row-name column.
 * @param {string}   [data.footLabel='All stages'] Label on the totals row.
 * @param {Function} [data.formatValue]       Renders a cell value. Defaults to
 *   the number itself; pass a currency formatter for money metrics.
 * @param {string}   [data.emptyTitle]
 * @param {string}   [data.emptyHint]
 * @returns {string} HTML for the matrix, or an empty state when nothing moved.
 */
export function renderTrendMatrix({
  buckets,
  rows,
  deltaLabel = 'Δ',
  rowLabel = 'Stage',
  footLabel = 'All stages',
  formatValue = (n) => n,
  emptyTitle = 'No movement in this period',
  emptyHint = 'Stage changes will show up here as the team works leads.',
}) {
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  if (grandTotal === 0) {
    return emptyState('fa-chart-line', emptyTitle, emptyHint);
  }

  const head = `
    <tr>
      <th class="trend-rowhead">${escapeHtml(rowLabel)}</th>
      ${buckets.map((b) => `<th>${escapeHtml(b.label)}</th>`).join('')}
      <th class="trend-total">Total</th>
      <th class="trend-delta">${escapeHtml(deltaLabel)}</th>
    </tr>`;

  const body = rows.map((r) => {
    const cells = buckets.map((b) => {
      const n = r.counts[b.key] || 0;
      return `<td class="${n === 0 ? 'trend-zero' : ''}">${formatValue(n)}</td>`;
    }).join('');
    return `
      <tr>
        <td class="trend-rowhead">${escapeHtml(r.label)}</td>
        ${cells}
        <td class="trend-total">${formatValue(r.total)}</td>
        ${deltaCell(deltaFor(r.counts, buckets), formatValue)}
      </tr>`;
  }).join('');

  // Column totals — "how much moved at all", the header number for the period.
  const colTotals = buckets.map((b) => {
    const n = rows.reduce((sum, r) => sum + (r.counts[b.key] || 0), 0);
    return `<td class="${n === 0 ? 'trend-zero' : ''}">${formatValue(n)}</td>`;
  }).join('');
  const allCounts = {};
  buckets.forEach((b) => { allCounts[b.key] = rows.reduce((sum, r) => sum + (r.counts[b.key] || 0), 0); });

  const foot = `
    <tr class="trend-foot">
      <td class="trend-rowhead">${escapeHtml(footLabel)}</td>
      ${colTotals}
      <td class="trend-total">${formatValue(grandTotal)}</td>
      ${deltaCell(deltaFor(allCounts, buckets), formatValue)}
    </tr>`;

  return `<div class="trend-scroll"><table class="trend-table"><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>`;
}

/** Granularity pills. `active` is one of 'day' | 'week' | 'month'. */
export function renderGranularityPills(active) {
  const opts = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']];
  return opts
    .map(([v, label]) => `<button type="button" class="pill-btn ${v === active ? 'active' : ''}" data-granularity="${v}">${label}</button>`)
    .join('');
}
