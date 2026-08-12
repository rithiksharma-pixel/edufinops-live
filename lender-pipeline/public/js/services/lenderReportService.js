// =========================================================
// SERVICE LAYER — Lender's own performance report.
//
// Everything here is scoped to the caller's bank by the database, not by
// this file: lender_milestone_counts() and lender_milestone_series() read
// v_lender_milestones, a security-barrier view carrying an explicit
// `is_lender_side() and belongs_to_lender_org(...)` predicate (migration
// 037). There is deliberately no org id passed from the client — it could
// be tampered with; auth.uid() cannot.
//
// Note this does NOT reuse v_stage_milestones, which powers the internal
// Milestones card. That view is security_invoker and joins `leads`, which
// a lender has no policy on, so it returns zero rows for them. The
// milestone definitions in v_lender_milestones are copied from it verbatim
// so the lender's numbers and ours agree.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export const MILESTONES = ['Login', 'Sanction', 'PF Paid', 'Disbursement'];

/**
 * Counts + total value per milestone for an inclusive date window.
 * Always one entry per milestone, zero-filled, so a quiet period renders
 * as "0" rather than the row silently disappearing.
 */
export async function getMilestoneCounts(from, to) {
  const { data, error } = await supabase.rpc('lender_milestone_counts', { p_from: from, p_to: to });
  if (error) throw error;
  const byName = new Map((data || []).map((r) => [r.milestone, r]));
  return MILESTONES.map((name) => ({
    milestone: name,
    deal_count: Number(byName.get(name)?.deal_count || 0),
    total_amount: Number(byName.get(name)?.total_amount || 0),
  }));
}

/** Milestone × time-bucket matrix, in the shape shared/js/trendsView.js renders. */
export async function getMilestoneSeries(from, to, granularity, buckets) {
  const { data, error } = await supabase.rpc('lender_milestone_series', {
    p_from: from, p_to: to, p_bucket: granularity,
  });
  if (error) throw error;

  const byMilestone = new Map(
    MILESTONES.map((name) => [name, { id: name, label: name, counts: {}, total: 0 }]),
  );
  for (const row of data || []) {
    const entry = byMilestone.get(row.milestone);
    if (!entry) continue; // an unknown milestone name should not crash the chart
    const value = Number(row.deal_count || 0);
    entry.counts[row.bucket_start] = (entry.counts[row.bucket_start] || 0) + value;
    entry.total += value;
  }
  return { buckets, rows: [...byMilestone.values()] };
}

/**
 * The individual milestone rows behind those counts — used for the CSV, so
 * the export and the totals on screen can never disagree.
 */
export async function getMilestoneRows(from, to) {
  const PAGE = 1000;
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('v_lender_milestones')
      .select('event_date, milestone, student_name, student_phone, lender_branch, amount, reference, is_on_hold, is_rejected, deal_id')
      .gte('event_date', from)
      .lte('event_date', to)
      .order('event_date', { ascending: false })
      .order('deal_id', { ascending: false })
      .order('milestone', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}
