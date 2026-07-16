// =========================================================
// SHARED SERVICE — Stage movement trends over time.
//
// Answers "how many leads/deals REACHED each stage per day / week /
// month", which is throughput — a different question from the funnel's
// "how many sit in each stage right now" (a snapshot). Throughput is what
// makes month-on-month comparison meaningful: a snapshot can look flat
// while nothing actually moved.
//
// Source of truth is the *_events tables: a stage transition writes a row
// with to_stage_id set, so counting those rows per bucket gives entries
// into a stage. Rows without to_stage_id (call logs, remarks) are ignored.
//
// Scoping is automatic and needs no filtering here: RLS on lead_events
// (can_view_lead) and deal_events already limits a Manager/ATM to their
// own team's records and gives Admin everything.
//
// Exported as a factory taking the app's own supabase client, matching
// shared/js/authService.js — never spins up a second GoTrueClient.
// =========================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d) { // weeks run Monday–Sunday
  const x = startOfDay(d);
  const day = x.getDay(); // 0 = Sunday
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}
function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }

const GRANULARITIES = {
  day: {
    count: 7,
    startOf: startOfDay,
    prev: (d) => new Date(d.getTime() - DAY_MS),
    next: (d) => new Date(d.getTime() + DAY_MS),
    label: (d) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
  },
  week: {
    count: 8,
    startOf: startOfWeek,
    prev: (d) => new Date(d.getTime() - 7 * DAY_MS),
    next: (d) => new Date(d.getTime() + 7 * DAY_MS),
    label: (d) => `w/c ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
  },
  month: {
    count: 6,
    startOf: startOfMonth,
    prev: (d) => { const x = new Date(d); x.setMonth(x.getMonth() - 1); return x; },
    next: (d) => { const x = new Date(d); x.setMonth(x.getMonth() + 1); return x; },
    label: (d) => d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
  },
};

/**
 * Oldest→newest list of time buckets for a granularity, each
 * { key, label, start, end }. Built in the viewer's local timezone, so
 * "today" means their today.
 */
export function buildBuckets(granularity) {
  const cfg = GRANULARITIES[granularity] || GRANULARITIES.day;
  const buckets = [];
  let cursor = cfg.startOf(new Date());
  for (let i = 0; i < cfg.count; i++) {
    buckets.unshift({ start: new Date(cursor), label: cfg.label(cursor) });
    cursor = cfg.prev(cursor);
  }
  buckets.forEach((b, i) => {
    b.end = i + 1 < buckets.length ? buckets[i + 1].start : cfg.next(b.start);
    b.key = b.start.toISOString();
  });
  return buckets;
}

function bucketKeyFor(date, buckets) {
  const t = new Date(date).getTime();
  for (const b of buckets) {
    if (t >= b.start.getTime() && t < b.end.getTime()) return b.key;
  }
  return null; // outside the window
}

/** Rolls event rows into { rowId: { bucketKey: count } } plus per-row totals. */
function tally(events, buckets, rowIdOf, dateOf) {
  const matrix = {};
  for (const ev of events) {
    const rowId = rowIdOf(ev);
    if (!rowId) continue;
    const key = bucketKeyFor(dateOf(ev), buckets);
    if (!key) continue;
    if (!matrix[rowId]) matrix[rowId] = {};
    matrix[rowId][key] = (matrix[rowId][key] || 0) + 1;
  }
  return matrix;
}

export function createTrendsService(supabase) {
  /**
   * Leads entering each lead stage, per bucket.
   * @returns {{buckets:Array, rows:Array<{id,label,counts,total}>}}
   */
  async function getLeadStageTrends(granularity) {
    const buckets = buildBuckets(granularity);
    const [eventsRes, stagesRes] = await Promise.all([
      supabase
        .from('lead_events')
        .select('to_stage_id, created_at')
        .not('to_stage_id', 'is', null)
        .eq('is_deleted', false)
        .gte('created_at', buckets[0].start.toISOString()),
      supabase.from('lead_stages').select('id, name, sequence_order').eq('is_deleted', false).order('sequence_order'),
    ]);
    if (eventsRes.error) throw eventsRes.error;
    if (stagesRes.error) throw stagesRes.error;

    const matrix = tally(eventsRes.data, buckets, (e) => e.to_stage_id, (e) => e.created_at);
    return { buckets, rows: toRows(stagesRes.data, matrix, buckets) };
  }

  /**
   * Deals entering each deal stage, per bucket — optionally for one lender
   * ("bank wise"). Passing no lenderId gives every bank the caller can see.
   */
  async function getDealStageTrends(granularity, lenderId = null) {
    const buckets = buildBuckets(granularity);
    // deals!inner keeps this an inner join so a lender filter actually
    // restricts rows. deals.lender_id is the only FK to lenders, so this
    // embed is unambiguous (no PGRST201 risk).
    let eventsQuery = supabase
      .from('deal_events')
      .select('to_stage_id, created_at, deals!inner ( lender_id )')
      .not('to_stage_id', 'is', null)
      .eq('is_deleted', false)
      .gte('created_at', buckets[0].start.toISOString());
    if (lenderId) eventsQuery = eventsQuery.eq('deals.lender_id', lenderId);

    const [eventsRes, stagesRes] = await Promise.all([
      eventsQuery,
      supabase.from('deal_stages').select('id, name, sequence_order').eq('is_deleted', false).order('sequence_order'),
    ]);
    if (eventsRes.error) throw eventsRes.error;
    if (stagesRes.error) throw stagesRes.error;

    const matrix = tally(eventsRes.data, buckets, (e) => e.to_stage_id, (e) => e.created_at);
    return { buckets, rows: toRows(stagesRes.data, matrix, buckets) };
  }

  /** Banks to offer in the "bank wise" selector. */
  async function getTrendLenders() {
    const { data, error } = await supabase
      .from('lenders')
      .select('id, name')
      .eq('is_deleted', false)
      .order('name');
    if (error) throw error;
    return data;
  }

  return { getLeadStageTrends, getDealStageTrends, getTrendLenders, buildBuckets };
}

function toRows(stages, matrix, buckets) {
  return stages.map((s) => {
    const counts = matrix[s.id] || {};
    const total = buckets.reduce((sum, b) => sum + (counts[b.key] || 0), 0);
    return { id: s.id, label: s.name, counts, total };
  });
}
