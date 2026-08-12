// =========================================================
// SHARED SERVICE — BD (Business Development) performance.
//
// Answers "how is each BD person doing?" — channels, leads, logins,
// sanctions, PF paid, disbursed and disbursed amount — over a date window,
// and the same metrics bucketed daily / weekly / monthly.
//
// Every figure comes from the bd_performance() / bd_performance_series()
// RPCs (migration 034). Nothing is aggregated in the browser: unlike the
// stage-trend matrix, this rolls up leads AND four milestone types across
// every BD at once, so pulling the raw rows to count them client-side
// would mean paging the whole ledger on each granularity change.
//
// Both RPCs and the views under them are security_invoker, so RLS scopes
// them to the caller — a Manager sees their team's leads, an Admin the
// whole org. There is deliberately no role logic in this file.
//
// Exported as a factory taking the app's own supabase client, matching
// shared/js/authService.js and trendsService.js — never spins up a second
// GoTrueClient.
// =========================================================

// Date helpers live in dateBuckets.js — shared with the Lender portal's
// report, which needs the same bucketing but has nothing to do with BD.
// Imported for use below AND re-exported, since `export … from` alone
// would not bind the names in this module's own scope.
import { buildBuckets } from './dateBuckets.js';

export { toIsoDate, presetRange, buildBuckets } from './dateBuckets.js';

/** Row label for leads whose BD owner was never recorded. */
export const UNATTRIBUTED_LABEL = '(Unattributed)';

/**
 * Metrics offered by the trend matrix. `key` matches the column name
 * returned by bd_performance_series(); `amount` marks the one that is
 * money rather than a count, so the view can format it correctly.
 */
export const TREND_METRICS = [
  { key: 'leads', label: 'Leads' },
  { key: 'logins', label: 'Logins' },
  { key: 'sanctions', label: 'Sanctions' },
  { key: 'pf_paid', label: 'PF paid' },
  { key: 'disbursed', label: 'Disbursed' },
  { key: 'disbursed_amount', label: 'Disbursed amount', amount: true },
];

/** Columns of the leaderboard table, in display order. */
export const SUMMARY_COLUMNS = [
  { key: 'channels', label: 'Channels', title: 'Consultancies this BD owns' },
  { key: 'active_channels', label: 'Active', title: 'Channels that produced a lead in this period' },
  { key: 'leads', label: 'Leads', title: 'Leads created in this period' },
  { key: 'logins', label: 'Logins' },
  { key: 'sanctions', label: 'Sanctions' },
  { key: 'pf_paid', label: 'PF paid' },
  { key: 'disbursed', label: 'Disbursed', title: 'Deals with at least one disbursement tranche in this period' },
  { key: 'disbursed_amount', label: 'Disbursed ₹', amount: true },
];

export function createBdPerformanceService(supabase) {
  /**
   * Leaderboard for a date window. Pass nulls for both bounds to get
   * all-time ("Overall").
   * @returns {Promise<Array>} one row per BD, plus an unattributed row when
   *   BD-sourced leads exist with no owner recorded.
   */
  async function getSummary(from = null, to = null) {
    const { data, error } = await supabase.rpc('bd_performance', { p_from: from, p_to: to });
    if (error) throw error;
    return (data || []).map((row) => ({
      ...row,
      // bd_name is null for the unattributed bucket. Labelling it here keeps
      // every caller — table, CSV, tooltip — using the same wording.
      displayName: row.bd_name || UNATTRIBUTED_LABEL,
      isUnattributed: !row.bd_name,
    }));
  }

  /**
   * BD × time-bucket matrix for one metric, in the shape
   * shared/js/trendsView.js renders.
   */
  async function getTrend(from, to, granularity, metricKey) {
    const { data, error } = await supabase.rpc('bd_performance_series', {
      p_from: from, p_to: to, p_bucket: granularity,
    });
    if (error) throw error;

    const buckets = buildBuckets(from, to, granularity);
    const byBd = new Map();
    for (const row of data || []) {
      const name = row.bd_name || UNATTRIBUTED_LABEL;
      if (!byBd.has(name)) byBd.set(name, { id: row.bd_key || '__unattributed__', label: name, counts: {}, total: 0 });
      const entry = byBd.get(name);
      const value = Number(row[metricKey] || 0);
      // Same bucket_start can only appear once per BD, so accumulating is
      // equivalent to assigning — written as += so a future finer-grained
      // series can't silently overwrite.
      entry.counts[row.bucket_start] = (entry.counts[row.bucket_start] || 0) + value;
      entry.total += value;
    }

    const rows = [...byBd.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    return { buckets, rows };
  }

  /**
   * The row-level ledger behind the numbers — one row per lead created and
   * per milestone hit — for the detail CSV. Same view the totals come from,
   * so the export and the screen can never disagree.
   */
  async function getActivityRows(from, to) {
    const PAGE = 1000;
    const all = [];
    // Paged by hand rather than via fetchAll(): that helper orders by `id`,
    // and this view has no single id column (it unions leads and milestones).
    // activity_date + lead_id + activity is a stable total order across pages.
    for (let offset = 0; ; offset += PAGE) {
      let query = supabase
        .from('v_bd_activity')
        .select('bd_name, bd_source, consultancy, activity, activity_date, amount, student_name, student_phone, lead_source, assigned_rm, lender, lender_branch, lead_id, deal_id')
        .order('activity_date', { ascending: false })
        .order('lead_id', { ascending: true })
        .order('activity', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (from) query = query.gte('activity_date', from);
      if (to) query = query.lte('activity_date', to);

      const { data, error } = await query;
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all.map((r) => ({ ...r, bd_name: r.bd_name || UNATTRIBUTED_LABEL }));
  }

  return { getSummary, getTrend, getActivityRows };
}

/** Column totals for the leaderboard footer. */
export function summaryTotals(rows) {
  const totals = {};
  for (const col of SUMMARY_COLUMNS) {
    totals[col.key] = rows.reduce((sum, r) => sum + Number(r[col.key] || 0), 0);
  }
  return totals;
}
