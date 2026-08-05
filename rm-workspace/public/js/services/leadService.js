// =========================================================
// SERVICE LAYER — New lead creation (RM Workspace)
// RLS's leads_insert_rm policy already scopes this correctly (is_rm());
// this file mirrors lead-management's createLead flow exactly, including
// self-assigning assigned_rm_id so the RETURNING select passes RLS.
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import { fetchAll } from '../../../../shared/js/fetchAll.js';

let sourceCache = null;
let stageCache = null;
let consultancyCache = null;

export async function getLeadSources() {
  if (sourceCache) return sourceCache;
  const { data, error } = await supabase
    .from('lead_sources')
    .select('id, name, category')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  sourceCache = data;
  return data;
}

/**
 * The id of the pipeline's FIRST stage — the one a lead is created at.
 * Exported because "New leads" means "still at this stage", and deriving
 * that from whatever stages happen to be present in a result set is what
 * made that view show already-worked leads once an RM cleared their new
 * ones (see dashboardService.getNewLeads).
 */
export async function getOpeningStageId() {
  if (stageCache) return stageCache;
  const { data, error } = await supabase
    .from('lead_stages')
    .select('id, sequence_order')
    .eq('is_deleted', false)
    .order('sequence_order', { ascending: true })
    .limit(1)
    .single();
  if (error) throw error;
  stageCache = data.id;
  return stageCache;
}

export async function getConsultancies() {
  if (consultancyCache) return consultancyCache;
  // Paged — 761 consultancies today and climbing; the BD Partnership
  // picker must not silently lose the tail of the alphabet at 1000.
  const data = await fetchAll(
    () => supabase
      .from('consultancies')
      .select('id, name')
      .eq('is_active', true)
      .eq('is_deleted', false)
      .order('name', { ascending: true })
  );
  consultancyCache = data;
  return data;
}

/**
 * Existing leads carrying this phone number, for the duplicate warning on
 * the new-lead form.
 *
 * IMPORTANT — this only sees what RLS lets the caller see, which for an RM
 * is their OWN leads (leads_select scopes on assigned_rm_id). So it catches
 * the common case — an RM re-entering someone they already hold — but NOT a
 * duplicate sitting with a different RM. Catching those needs a security-
 * definer RPC that can look across the whole table; deliberately not done
 * here because it's a schema change, and a partial check that warns is
 * still better than the nothing that was here before.
 *
 * Matching is on digits only and on the last 10 of them, because the same
 * number gets typed as "+91 98765 43210", "098765-43210" and "9876543210"
 * by different people. That normalisation can't be expressed as an ilike
 * against the raw column — '%9876543210%' does not match '+91 98765 43210'
 * — so the rows come back and the comparison happens here.
 */
function phoneKey(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export async function findLeadsByPhone(phone) {
  const key = phoneKey(phone);
  if (key.length < 7) return [];
  const rows = await fetchAll(
    () => supabase
      .from('leads')
      .select('id, student_name, student_phone')
      .eq('is_deleted', false)
      .order('student_name')
  );
  return rows.filter((l) => phoneKey(l.student_phone) === key);
}

export async function createLead(payload, currentUserId) {
  const openingStageId = await getOpeningStageId();
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      ...payload,
      current_stage_id: openingStageId,
      assigned_rm_id: currentUserId,
      created_by: currentUserId,
      updated_by: currentUserId,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: eventError } = await supabase.from('lead_events').insert({
    lead_id: lead.id,
    event_type: 'Lead Created',
    to_stage_id: openingStageId,
    created_by: currentUserId,
  });
  if (eventError) {
    throw new Error(`Lead saved, but its timeline entry failed: ${eventError.message}`);
  }

  return lead;
}
