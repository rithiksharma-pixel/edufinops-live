// =========================================================
// SERVICE LAYER — "My Students" (Consultant's own sourced leads)
// RLS already scopes every query here to source_user_id = auth.uid();
// this file never needs to add its own WHERE clause for that — it's
// enforced at the database, which is the actual security boundary.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export async function listMyLeads(search) {
  let query = supabase
    .from('leads')
    .select(`
      id, student_name, student_phone, course_name, university_name,
      loan_amount_requested, currency, created_at,
      lead_stages ( name, color )
    `)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });

  if (search) {
    // See lead-management/leadService.js: strip PostgREST or()-grammar chars
    // so a phone like "(555) 123-4567" doesn't 400 the request.
    const s = search.replace(/[,()"\\%_]/g, ' ').trim();
    if (s) query = query.or(`student_name.ilike.%${s}%,student_phone.ilike.%${s}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getLeadDetail(leadId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*, lead_stages ( name ), lead_sources ( name )')
    .eq('id', leadId)
    .single();
  if (error) throw error;
  return data;
}

export async function getLeadTimeline(leadId) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('event_type, remarks, created_at, from_stage:lead_stages!lead_events_from_stage_id_fkey(name), to_stage:lead_stages!lead_events_to_stage_id_fkey(name)')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Creates a lead attributed to the current Consultant, plus its
 * opening timeline event. RLS's leads_insert_source policy already
 * enforces source_user_id = auth.uid() — this just fills it in.
 */
export async function createMyLead(payload, currentUserId, openingStageId) {
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({ ...payload, source_user_id: currentUserId, current_stage_id: openingStageId, created_by: currentUserId, updated_by: currentUserId })
    .select()
    .single();
  if (error) throw error;

  const { error: eventError } = await supabase
    .from('lead_events')
    .insert({ lead_id: lead.id, event_type: 'Lead Created', to_stage_id: openingStageId, created_by: currentUserId });
  if (eventError) throw new Error(`Lead saved, but its timeline entry failed: ${eventError.message}`);

  return lead;
}
