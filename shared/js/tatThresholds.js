// =========================================================
// SHARED SERVICE — Per-stage TAT (turn-around-time) breach thresholds.
//
// Was a hardcoded const (STAGE_TAT_THRESHOLD_DAYS), duplicated in
// manager-dashboard's analyticsService.js and admin-dashboard's app.js.
// Now lives in stage_tat_thresholds (deployment/032), editable from Admin
// Console -> Settings. Takes the caller's own supabase client rather than
// importing one, matching shared/js/trendsService.js — never spins up a
// second GoTrueClient.
// =========================================================

/**
 * @returns {Promise<Object<string, number>>} stage name -> threshold days.
 *   A stage with no row (never configured, or cleared back to "not
 *   tracked") is simply absent from the map — callers should treat a
 *   missing key as "don't flag this stage" rather than defaulting it.
 */
export async function getTatThresholds(supabase) {
  const { data, error } = await supabase
    .from('stage_tat_thresholds')
    .select('threshold_days, deal_stages(name)')
    .eq('is_deleted', false);
  if (error) throw error;

  const map = {};
  (data || []).forEach((row) => {
    if (row.deal_stages?.name) map[row.deal_stages.name] = row.threshold_days;
  });
  return map;
}
