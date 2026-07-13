// =========================================================
// SERVICE LAYER — Leads
// Presentation code (components/app.js) calls only these functions.
// Nothing outside this file constructs a Supabase query for `leads`.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

const LEAD_LIST_SELECT = `
  id, student_name, student_phone, student_email,
  course_name, university_name, loan_amount_requested, currency,
  next_follow_up_at, last_activity_at,
  current_stage_id, assigned_rm_id,
  lead_stages ( name, color ),
  assigned_rm:users!leads_assigned_rm_id_fkey ( full_name )
`;

/**
 * Fetch leads with optional filters. RLS already restricts rows to what
 * the current user's role is allowed to see — this function does not
 * need to (and must not) apply its own role-based scoping.
 */
export async function listLeads({ stageId, sourceId, rmId, search } = {}) {
  let query = supabase
    .from('leads')
    .select(LEAD_LIST_SELECT)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });

  if (stageId) query = query.eq('current_stage_id', stageId);
  if (sourceId) query = query.eq('lead_source_id', sourceId);
  if (rmId) query = query.eq('assigned_rm_id', rmId);
  if (search) {
    query = query.or(`student_name.ilike.%${search}%,student_phone.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Stage counts for the funnel summary row. One query, grouped client-side
 * (Supabase JS doesn't do GROUP BY directly without a Postgres function;
 * for a table this size a client-side reduce is cheap and avoids an extra
 * RPC just for counting).
 */
export async function getStageCounts() {
  const { data, error } = await supabase
    .from('leads')
    .select('current_stage_id')
    .eq('is_deleted', false);
  if (error) throw error;

  const counts = {};
  for (const row of data) {
    counts[row.current_stage_id] = (counts[row.current_stage_id] || 0) + 1;
  }
  return counts;
}

export async function getLeadDetail(leadId) {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select(`
      *,
      lead_stages ( name, color ),
      lead_sources ( name, category ),
      assigned_rm:users!leads_assigned_rm_id_fkey ( full_name )
    `)
    .eq('id', leadId)
    .single();
  if (leadError) throw leadError;

  const { data: coApplicants, error: coError } = await supabase
    .from('co_applicants')
    .select('*')
    .eq('lead_id', leadId)
    .eq('is_deleted', false);
  if (coError) throw coError;

  return { lead, coApplicants };
}

export async function getLeadTimeline(leadId) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('*, from_stage:lead_stages!lead_events_from_stage_id_fkey(name), to_stage:lead_stages!lead_events_to_stage_id_fkey(name), created_by_user:users(full_name)')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Creates a lead plus its opening "Lead Created" timeline event.
 * These two writes should be atomic; until that's moved into an RPC
 * (tracked in future improvements), we do the event insert immediately
 * after and surface a clear error if it fails so the caller can retry
 * the event write without duplicating the lead.
 */
export async function createLead(payload, currentUserId, initialStageId) {
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      ...payload,
      current_stage_id: initialStageId,
      created_by: currentUserId,
      updated_by: currentUserId,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: eventError } = await supabase.from('lead_events').insert({
    lead_id: lead.id,
    event_type: 'Lead Created',
    to_stage_id: initialStageId,
    created_by: currentUserId,
  });
  if (eventError) {
    // Lead exists but its opening event failed to write — surface distinctly
    // so the UI can tell the user to open the lead and check its timeline.
    throw new Error(`Lead saved, but its timeline entry failed: ${eventError.message}`);
  }

  return lead;
}

export async function changeLeadStage(leadId, newStageId, remarks) {
  const { error } = await supabase.rpc('change_lead_stage', {
    p_lead_id: leadId,
    p_new_stage_id: newStageId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function assignLeadToRm(leadId, newRmId, reason) {
  const { error } = await supabase.rpc('assign_lead', {
    p_lead_id: leadId,
    p_new_rm_id: newRmId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}
