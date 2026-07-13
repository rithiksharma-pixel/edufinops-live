// =========================================================
// SERVICE LAYER — RM Workspace dashboard views
// RLS already scopes leads/deals/documents to "assigned to me" for
// the RM role — every query here relies on that, never re-filters
// client-side for security (only for display grouping).
// =========================================================
import { supabase } from '../config/supabaseClient.js';

const LEAD_SELECT = `
  id, student_name, student_phone, course_name, university_name,
  loan_amount_requested, currency, next_follow_up_at, created_at,
  lead_stages ( name, sequence_order )
`;

export async function getAssignedLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_SELECT)
    .eq('is_deleted', false)
    .order('next_follow_up_at', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data;
}

export async function getTodaysFollowUps() {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_SELECT)
    .eq('is_deleted', false)
    .lte('next_follow_up_at', endOfToday.toISOString())
    .not('next_follow_up_at', 'is', null)
    .order('next_follow_up_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getNewLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_SELECT)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });
  if (error) throw error;
  // "New" = still at the very first stage (untouched since creation).
  // Filtered client-side on sequence_order since it's a small, already-
  // RLS-scoped result set, not worth a second round trip for.
  const minOrder = Math.min(...data.map((l) => l.lead_stages?.sequence_order ?? Infinity));
  return data.filter((l) => l.lead_stages?.sequence_order === minOrder);
}

export async function getDocumentsPending() {
  const { data, error } = await supabase
    .from('documents')
    .select(`
      id, file_name, uploaded_at,
      document_types ( name ),
      leads ( id, student_name )
    `)
    .eq('verification_status', 'Pending Review')
    .eq('is_deleted', false)
    .order('uploaded_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getLenderUpdates() {
  const { data, error } = await supabase
    .from('deal_events')
    .select(`
      id, event_type, remarks, created_at,
      deals ( lenders ( name ), leads ( id, student_name ) )
    `)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return data;
}
