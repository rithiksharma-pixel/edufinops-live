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

/**
 * Fetches the EL Details extension data for a lead: university choices,
 * academic details, parent details, collateral, and both references.
 * Kept as one call so leadDrawer.js can fetch it alongside getLeadDetail
 * in the same Promise.all it already uses for stages/RMs/timeline.
 */
export async function getLeadExtendedDetail(leadId) {
  const [universities, academic, parents, collateral, references] = await Promise.all([
    supabase.from('lead_university_choices').select('*').eq('lead_id', leadId).eq('is_deleted', false).order('sequence_order'),
    supabase.from('lead_academic_details').select('*').eq('lead_id', leadId).eq('is_deleted', false).maybeSingle(),
    supabase.from('lead_parent_details').select('*').eq('lead_id', leadId).eq('is_deleted', false).maybeSingle(),
    supabase.from('lead_collateral_details').select('*').eq('lead_id', leadId).eq('is_deleted', false),
    supabase.from('lead_references').select('*').eq('lead_id', leadId).eq('is_deleted', false),
  ]);
  for (const r of [universities, academic, parents, collateral, references]) {
    if (r.error) throw r.error;
  }
  return {
    universities: universities.data,
    academic: academic.data,
    parents: parents.data,
    collateral: collateral.data,
    references: references.data,
  };
}

/** Personal ID + Loan Identification + Addresses + Alternate Contact + Employment — all plain leads columns. */
export async function updateApplicantDetails(leadId, fields) {
  const { error } = await supabase.from('leads').update(fields).eq('id', leadId);
  if (error) throw error;
}

export async function upsertUniversityChoices(leadId, choices, currentUserId) {
  // choices: [{ sequence_order, university_name }]. Replace-all is simplest
  // and correct here — there are at most 6 rows per lead, so a delete+insert
  // is cheap and avoids tracking which rows changed client-side.
  const { error: delError } = await supabase.from('lead_university_choices').delete().eq('lead_id', leadId);
  if (delError) throw delError;
  const rows = choices
    .filter((c) => c.university_name?.trim())
    .map((c) => ({ lead_id: leadId, sequence_order: c.sequence_order, university_name: c.university_name.trim(), created_by: currentUserId, updated_by: currentUserId }));
  if (rows.length === 0) return;
  const { error } = await supabase.from('lead_university_choices').insert(rows);
  if (error) throw error;
}

export async function upsertAcademicDetails(leadId, fields, currentUserId) {
  const { error } = await supabase
    .from('lead_academic_details')
    .upsert({ lead_id: leadId, ...fields, updated_by: currentUserId, created_by: currentUserId }, { onConflict: 'lead_id' });
  if (error) throw error;
}

export async function upsertParentDetails(leadId, fields, currentUserId) {
  const { error } = await supabase
    .from('lead_parent_details')
    .upsert({ lead_id: leadId, ...fields, updated_by: currentUserId, created_by: currentUserId }, { onConflict: 'lead_id' });
  if (error) throw error;
}

export async function updateCoApplicant(coApplicantId, fields) {
  const { error } = await supabase.from('co_applicants').update(fields).eq('id', coApplicantId);
  if (error) throw error;
}

export async function createCoApplicant(leadId, fields, currentUserId) {
  const { error } = await supabase.from('co_applicants').insert({ lead_id: leadId, ...fields, created_by: currentUserId, updated_by: currentUserId });
  if (error) throw error;
}

export async function upsertCollateralDetails(leadId, collateralId, fields, currentUserId) {
  if (collateralId) {
    const { error } = await supabase.from('lead_collateral_details').update(fields).eq('id', collateralId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('lead_collateral_details').insert({ lead_id: leadId, ...fields, created_by: currentUserId, updated_by: currentUserId });
  if (error) throw error;
}

// Fixed list for now — matches the roadmap's "adjust the list on request".
export const CALL_STATUS_OPTIONS = [
  'Connected', 'No Answer', 'Busy', 'Call Back Requested', 'Interested', 'Not Interested', 'Wrong Number',
];

/**
 * Logs a call as a lead_events row (shows up in the Timeline tab with no
 * extra UI needed) and, unless the outcome was "Not Interested", creates
 * the mandatory follow-up task and syncs leads.next_follow_up_at to its
 * due date so the Overview field and every "overdue follow-up" query
 * elsewhere in the app stay correct for free.
 */
export async function logCall(leadId, { callStatus, notes, taskTitle, taskDueDate }, currentUserId) {
  const { error: eventError } = await supabase.from('lead_events').insert({
    lead_id: leadId,
    event_type: callStatus,
    remarks: notes?.trim() || null,
    created_by: currentUserId,
  });
  if (eventError) throw eventError;

  if (!taskTitle) return;

  const { error: taskError } = await supabase.from('tasks').insert({
    title: taskTitle,
    due_date: taskDueDate,
    lead_id: leadId,
    assigned_to_user_id: currentUserId,
    created_by: currentUserId,
    updated_by: currentUserId,
  });
  if (taskError) throw new Error(`Call logged, but the follow-up task failed to save: ${taskError.message}`);

  const { error: leadUpdateError } = await supabase.from('leads').update({ next_follow_up_at: taskDueDate }).eq('id', leadId);
  if (leadUpdateError) throw new Error(`Call logged and task saved, but updating the lead's next follow-up failed: ${leadUpdateError.message}`);
}

export async function upsertReference(leadId, referenceType, fields, currentUserId) {
  const { error } = await supabase
    .from('lead_references')
    .upsert({ lead_id: leadId, reference_type: referenceType, ...fields, updated_by: currentUserId, created_by: currentUserId }, { onConflict: 'lead_id,reference_type' });
  if (error) throw error;
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

/**
 * A lead's effective status once it's in the lender pipeline is the
 * furthest-along stage of any of its live deals — a deal at "Sanction"
 * means the lead is effectively Sanctioned, regardless of the lead's own
 * pipeline stage. Returns the highest deal-stage name among non-rejected
 * deals, or null when the lead has no live deals (caller falls back to
 * the lead's own stage). Rejected deals don't count as progress.
 *
 * For Consultant/BD, RLS returns zero deal rows, so this yields null and
 * they see the lead's own stage — exactly what we want.
 */
export async function getHighestDealStage(leadId) {
  const { data, error } = await supabase
    .from('deals')
    .select('current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name, sequence_order )')
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .eq('is_rejected', false);
  if (error) throw error;
  const stages = (data || []).map((d) => d.current_deal_stage).filter(Boolean);
  if (stages.length === 0) return null;
  return stages.sort((a, b) => b.sequence_order - a.sequence_order)[0].name;
}
