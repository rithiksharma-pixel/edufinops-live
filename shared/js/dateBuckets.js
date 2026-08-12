// =========================================================
// SHARED — date-range presets and time bucketing for reports.
//
// Extracted from bdPerformanceService.js once the Lender portal's report
// needed the same helpers: a lender app importing from a module named
// "bdPerformance" would have been a confusing dependency, and these are
// not BD-specific in any way.
//
// Buckets are built in the VIEWER's local timezone and keyed by the same
// ISO date string Postgres returns from date_trunc(), so a client bucket
// and a server bucket line up by plain string equality.
// =========================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * YYYY-MM-DD in local time.
 *
 * Deliberately not toISOString().slice(0,10): that converts to UTC first,
 * so any IST time before 05:30 lands on the previous day — which would
 * silently shift every "today" range back by one.
 */
export function toIsoDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Inclusive window covering the last `days` days, ending today. */
export function presetRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * DAY_MS);
  return { from: toIsoDate(from), to: toIsoDate(to) };
}

/** Monday-start, matching Postgres date_trunc('week', …). */
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0 = Sunday
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}

const BUCKET_LABELS = {
  day: (d) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
  week: (d) => `w/c ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
  month: (d) => d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
};

/**
 * Oldest→newest buckets spanning [from, to], each { key, label, start }.
 *
 * Built from the range rather than from the query's result rows, because a
 * bucket in which nothing happened returns no row at all — and a trend
 * matrix that silently drops its quiet weeks is misleading.
 *
 * @param {string} from  ISO date, inclusive
 * @param {string} to    ISO date, inclusive
 * @param {'day'|'week'|'month'} granularity
 */
export function buildBuckets(from, to, granularity) {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const buckets = [];

  let cursor;
  if (granularity === 'week') cursor = startOfWeek(start);
  else if (granularity === 'month') cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  else cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  // Hard stop as well as the date condition: a bad range must not spin.
  for (let guard = 0; cursor <= end && guard < 750; guard++) {
    buckets.push({ key: toIsoDate(cursor), label: BUCKET_LABELS[granularity](cursor), start: new Date(cursor) });
    if (granularity === 'day') cursor = new Date(cursor.getTime() + DAY_MS);
    else if (granularity === 'week') cursor = new Date(cursor.getTime() + 7 * DAY_MS);
    else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return buckets;
}
