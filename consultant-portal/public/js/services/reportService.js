// =========================================================
// SERVICE LAYER — the Consultant's own scorecard, plus the bank-by-bank
// progress on a single student.
//
// Both call SECURITY DEFINER RPCs (migration 036/037) rather than querying
// tables, for the same reason: a source role gets ZERO rows from `deals`
// and cannot read `lenders` at all, so "did my student get sanctioned?"
// is unanswerable from the portal without one.
//
// The scoping is inside the functions, not here — source_performance()
// filters on source_user_id = auth.uid() and refuses any role that is not
// Consultant / Business Development, and get_lead_lender_progress() checks
// can_view_lead(). Nothing this file passes can widen that.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

/** Headline numbers for a date window. Nulls for both bounds = all time. */
export async function getMyPerformance(from = null, to = null) {
  const { data, error } = await supabase.rpc('source_performance', { p_from: from, p_to: to });
  if (error) throw error;
  // Returns a single row; PostgREST hands back a one-element array.
  return (Array.isArray(data) ? data[0] : data) || {};
}

/** The caller's own students per lead stage, zero-filled across all stages. */
export async function getMyStageBreakdown(from = null, to = null) {
  const { data, error } = await supabase.rpc('source_stage_breakdown', { p_from: from, p_to: to });
  if (error) throw error;
  return data || [];
}

/**
 * Which banks this student went to and where each one stands.
 * Stage only — no sanction amounts, interest rates or internal remarks.
 */
export async function getLenderProgress(leadId) {
  const { data, error } = await supabase.rpc('get_lead_lender_progress', { p_lead_id: leadId });
  if (error) throw error;
  return data || [];
}
