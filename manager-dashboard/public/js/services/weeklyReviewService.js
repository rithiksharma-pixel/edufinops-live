// =========================================================
// DATA LAYER — Weekly Business Review
// One RPC returns the whole report as JSON (migration 057); everything the
// deck shows is derived from that single payload, so no two slides can
// disagree about a number.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

/**
 * Fetch the review for the week ending `weekEnd` (a YYYY-MM-DD string, or
 * null for the week ending today).
 */
export async function fetchReviewData(weekEnd = null) {
  const { data, error } = await supabase.rpc('weekly_review_data', { p_week_end: weekEnd });
  if (error) throw error;
  return data;
}

/** Persist a generated review so it appears in the Weekly Reviews list. */
export async function saveReview({ weekStart, weekEnd, title, payload, userId }) {
  const { data, error } = await supabase
    .from('weekly_reviews')
    .insert({
      week_start: weekStart,
      week_end: weekEnd,
      title,
      payload,
      generated_by: userId,
    })
    .select('id, title, week_start, week_end, generated_at')
    .single();
  if (error) throw error;
  return data;
}

export async function listReviews(limit = 25) {
  const { data, error } = await supabase
    .from('weekly_reviews')
    .select('id, title, week_start, week_end, generated_at, generated_by, users:generated_by(full_name)')
    .eq('is_deleted', false)
    .order('week_end', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getReview(id) {
  const { data, error } = await supabase
    .from('weekly_reviews')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function deleteReview(id) {
  const { error } = await supabase.from('weekly_reviews').update({ is_deleted: true }).eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------
// Targets
// ---------------------------------------------------------

export async function listTargets(periodType, periodStart) {
  const { data, error } = await supabase
    .from('review_targets')
    .select('id, period_type, period_start, owner_id, metric, target_value, users:owner_id(full_name)')
    .eq('period_type', periodType)
    .eq('period_start', periodStart);
  if (error) throw error;
  return data ?? [];
}

/**
 * Upsert on the natural key. owner_id null means a team-level target — and
 * because Postgres treats nulls as distinct in a unique index, the
 * team-level row needs the same onConflict list to update rather than
 * duplicate.
 */
export async function saveTarget({ periodType, periodStart, ownerId, metric, targetValue, userId }) {
  const { error } = await supabase.from('review_targets').upsert(
    {
      period_type: periodType,
      period_start: periodStart,
      owner_id: ownerId ?? null,
      metric,
      target_value: targetValue,
      created_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'period_type,period_start,owner_id,metric' }
  );
  if (error) throw error;
}
