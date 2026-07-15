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
import { CALL_STATUS_OPTIONS } from '../../../../lead-management/public/js/services/leadService.js';

export { CALL_STATUS_OPTIONS };

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Calendar week starting Monday 00:00 local time.
function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Fetches this RM's own logged calls for the given period ('today' | 'week'),
 * newest first, with the student name attached for display.
 */
export async function getMyCalls(currentUserId, period = 'today') {
  const since = period === 'week' ? startOfWeek() : startOfToday();
  const { data, error } = await supabase
    .from('lead_events')
    .select('id, event_type, remarks, created_at, leads ( id, student_name )')
    .in('event_type', CALL_STATUS_OPTIONS)
    .eq('created_by', currentUserId)
    .eq('is_deleted', false)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
