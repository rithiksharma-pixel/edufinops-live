// =========================================================
// SERVICE LAYER — New lead creation (RM Workspace)
// RLS's leads_insert_rm policy already scopes this correctly (is_rm());
// this file mirrors lead-management's createLead flow exactly, including
// self-assigning assigned_rm_id so the RETURNING select passes RLS.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

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

async function getOpeningStageId() {
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
  const { data, error } = await supabase
    .from('consultancies')
    .select('id, name')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  consultancyCache = data;
  return data;
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
