// =========================================================
// SERVICE LAYER — Pipeline milestone counts by date range
//
// Login / Sanction / PF dates are not columns on `deals` — each stage
// keeps its own detail table (deal_login_details, deal_sanction_details,
// deal_pf_details), with the final disbursement date on the deal itself.
// v_stage_milestones flattens all four into one row-per-milestone shape
// so a date-range count is a plain filter instead of a four-way join.
//
// Both the view and milestone_counts() run with security_invoker, so RLS
// applies to whoever is calling: an RM's numbers cover their own deals, a
// Manager's their team, an Admin's everything. There is deliberately no
// role handling in this file — the database is the scoping boundary.
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import { fetchAll } from '../../../../shared/js/fetchAll.js';

export const MILESTONES = ['Login', 'Sanction', 'PF Paid', 'Disbursement'];

/**
 * Counts + total value per milestone for an inclusive date window.
 * @param {string} from ISO date, e.g. '2026-07-01'
 * @param {string} to   ISO date, inclusive of the whole day
 * @returns {Promise<Array<{milestone,deal_count,total_amount}>>} always
 *   one entry per milestone, zero-filled — so a quiet period renders as
 *   "0" rather than the row silently disappearing.
 */
export async function getMilestoneCounts(from, to) {
  const { data, error } = await supabase.rpc('milestone_counts', { p_from: from, p_to: to });
  if (error) throw error;

  const byName = new Map((data || []).map((r) => [r.milestone, r]));
  return MILESTONES.map((name) => ({
    milestone: name,
    deal_count: Number(byName.get(name)?.deal_count || 0),
    total_amount: Number(byName.get(name)?.total_amount || 0),
  }));
}

/**
 * The individual milestone rows behind those counts — used for the CSV,
 * so the export and the totals on screen can never disagree.
 */
export async function getMilestoneRows(from, to) {
  return fetchAll(
    () => supabase
      .from('v_stage_milestones')
      .select('event_date, milestone, student_name, student_phone, lender, lender_branch, assigned_rm, team, lead_source, amount, reference, deal_id')
      .gte('event_date', from)
      .lte('event_date', to)
      .order('event_date', { ascending: false }),
    { tiebreak: 'deal_id', ascending: false }
  );
}
