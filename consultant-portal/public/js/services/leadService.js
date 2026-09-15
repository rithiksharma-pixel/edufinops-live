// =========================================================
// SERVICE LAYER — "My Students"
//
// Reads go through SECURITY DEFINER RPCs (deployment/065), not the leads
// table. A consultant's firm is the real partner: a login linked to a
// consultancy sees every student that firm referred, not only the ones this
// person typed in. The RPCs return status-level fields only — no lender,
// sanction, PF or the RM team's working notes.
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import { fetchAll } from '../../../../shared/js/fetchAll.js';

export async function listMyStudents() {
  return fetchAll(() => supabase.rpc('consultant_students'), { tiebreak: 'lead_id' });
}

/** { consultancy_id, consultancy_name } — both null for an unlinked login. */
export async function getPortalContext() {
  const { data, error } = await supabase.rpc('consultant_portal_context');
  if (error) throw error;
  return data || {};
}

/** Milestones only: created, stage changes, lost. */
export async function getStudentTimeline(leadId) {
  const { data, error } = await supabase.rpc('consultant_student_timeline', { p_lead_id: leadId });
  if (error) throw error;
  return data || [];
}

/**
 * Creates a lead attributed to the current Consultant, plus its
 * opening timeline event. RLS's leads_insert_source policy already
 * enforces source_user_id = auth.uid(); trg_stamp_source_consultancy
 * attributes it to the consultant's own firm.
 */
export async function createMyLead(payload, currentUserId, openingStageId) {
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({ ...payload, source_user_id: currentUserId, current_stage_id: openingStageId, created_by: currentUserId, updated_by: currentUserId })
    .select('id')
    .single();
  if (error) throw error;

  const { error: eventError } = await supabase
    .from('lead_events')
    .insert({ lead_id: lead.id, event_type: 'Lead Created', to_stage_id: openingStageId, created_by: currentUserId });
  if (eventError) throw new Error(`Lead saved, but its timeline entry failed: ${eventError.message}`);

  return lead;
}
