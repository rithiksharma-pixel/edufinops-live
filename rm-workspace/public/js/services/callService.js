// =========================================================
// SERVICE LAYER — RM's own call activity (Calls tab)
// A "call" is a lead_events row whose event_type is one of
// CALL_STATUS_OPTIONS. That list is owned by Lead Management's
// leadService.js (the only place calls are logged) — imported here
// rather than re-declared so the two can never drift apart.
// RLS's lead_events_select policy (can_view_lead) already scopes
// visible rows to leads this RM can see; the created_by filter below
// narrows further to calls this RM personally logged, matching "my
// call activity" rather than "activity on my leads by anyone".
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import { fetchAll } from '../../../../shared/js/fetchAll.js';
import { CALL_STATUS_OPTIONS, CONNECTED_DISPOSITIONS } from '../../../../lead-management/public/js/services/leadService.js';

export { CALL_STATUS_OPTIONS, CONNECTED_DISPOSITIONS };

/**
 * Fetches this RM's own logged calls for a period (a value from
 * shared/js/periodPicker.js), newest first, with the student name attached
 * for display.
 */
export async function getMyCalls(currentUserId, period) {
  const data = await fetchAll(
    () => {
      let query = supabase
        .from('lead_events')
        .select('id, event_type, remarks, created_at, leads ( id, student_name )')
        .in('event_type', CALL_STATUS_OPTIONS)
        .eq('created_by', currentUserId)
        .eq('is_deleted', false);
      if (period.fromTs) query = query.gte('created_at', period.fromTs);
      if (period.toTs) query = query.lte('created_at', period.toTs);
      return query.order('created_at', { ascending: false });
    },
    { tiebreak: 'id', ascending: false }
  );
  return data;
}
