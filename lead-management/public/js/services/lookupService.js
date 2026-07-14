// =========================================================
// SERVICE LAYER — Lookup / reference data
// =========================================================
import { supabase } from '../config/supabaseClient.js';

let stageCache = null;
let sourceCache = null;

export async function getLeadStages() {
  if (stageCache) return stageCache;
  const { data, error } = await supabase
    .from('lead_stages')
    .select('id, name, sequence_order, is_terminal, color')
    .eq('is_deleted', false)
    .order('sequence_order', { ascending: true });
  if (error) throw error;
  stageCache = data;
  return data;
}

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
 * RMs visible to the current user — RLS on `users` already scopes this
 * to "your team" for Managers and "yourself" for RMs, so no client-side
 * filtering is required here.
 */
export async function getAssignableRms() {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, roles!inner(name)')
    .eq('roles.name', 'Relationship Manager')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('full_name', { ascending: true });
  if (error) throw error;
  return data;
}

let dealStageCache = null;
let dealStageStatusCache = null;
let rejectionReasonCache = null;
let holdReasonCache = null;
let lenderCache = null;

export async function getDealStages() {
  if (dealStageCache) return dealStageCache;
  const { data, error } = await supabase
    .from('deal_stages')
    .select('id, name, sequence_order, is_terminal')
    .eq('is_deleted', false)
    .order('sequence_order', { ascending: true });
  if (error) throw error;
  dealStageCache = data;
  return data;
}

/** All stage-statuses across all stages, in one call — filter client-side by deal_stage_id. */
export async function getDealStageStatuses() {
  if (dealStageStatusCache) return dealStageStatusCache;
  const { data, error } = await supabase
    .from('deal_stage_statuses')
    .select('id, deal_stage_id, name, sequence_order, is_terminal_for_stage')
    .eq('is_deleted', false)
    .order('sequence_order', { ascending: true });
  if (error) throw error;
  dealStageStatusCache = data;
  return data;
}

export async function getDealRejectionReasons() {
  if (rejectionReasonCache) return rejectionReasonCache;
  const { data, error } = await supabase
    .from('deal_rejection_reasons')
    .select('id, name')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  rejectionReasonCache = data;
  return data;
}

export async function getDealHoldReasons() {
  if (holdReasonCache) return holdReasonCache;
  const { data, error } = await supabase
    .from('deal_hold_reasons')
    .select('id, name')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  holdReasonCache = data;
  return data;
}

export async function getLenders() {
  if (lenderCache) return lenderCache;
  const { data, error } = await supabase
    .from('lenders')
    .select('id, name')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  lenderCache = data;
  return data;
}

let consultancyCache = null;

/** Admin-managed list for the "Consultancy name" field shown when Lead Source = BD Partnership. */
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

export async function getCounselors() {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, roles!inner(name)')
    .eq('roles.name', 'Counselor')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('full_name', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Lender-side users who can be set as a deal's loan officer, scoped to
 * one lender institution — with 17 lenders and multiple branches each,
 * an unfiltered list would be hundreds of names. Requires lenderId since
 * a deal's loan officer only ever makes sense once a lender is picked.
 */
export async function getLoanOfficers(lenderId) {
  if (!lenderId) return [];
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, roles!inner(name), lender_branches!users_lender_branch_id_fkey(name)')
    .eq('roles.name', 'Lender')
    .eq('lender_organization_id', lenderId)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('full_name', { ascending: true });
  if (error) throw error;
  return data;
}
