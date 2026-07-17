// =========================================================
// SERVICE LAYER — Manual lender-deal management (RM Workspace)
// No real lenders are onboarded yet (no loan officer users exist), so
// deals here are started without one via share_lead_with_lender's
// optional p_loan_officer_id, then progressed manually — region, stage,
// disposition, stage fields — standing in for what a lender's own
// portal would eventually do. Mirrors lead-management's dealService.js /
// lenderStatusService.js, scoped to just what this panel needs — same
// "each app owns its own copy" convention already used for
// STAGE_TABLE_MAP (see dashboardService.js).
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export const STAGE_TABLE_MAP = {
  'Bank Prospect': {
    table: 'deal_bank_prospect_details',
    fields: [
      { key: 'region_shared_date', label: 'Region shared date', type: 'date' },
      { key: 'sm_shared_date', label: 'SM shared date', type: 'date' },
      { key: 'rm_shared_date', label: 'RM shared date', type: 'date' },
      { key: 'eligibility_status', label: 'Eligibility status', type: 'text' },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ],
  },
  Login: {
    table: 'deal_login_details',
    fields: [
      { key: 'loan_required_amount', label: 'Loan required amount', type: 'number' },
      { key: 'login_amount', label: 'Login amount', type: 'number' },
      { key: 'login_date', label: 'Login date', type: 'date' },
      { key: 'probable_sanction_date', label: 'Probable sanction date', type: 'date' },
    ],
  },
  Sanction: {
    table: 'deal_sanction_details',
    fields: [
      { key: 'sanction_amount', label: 'Sanction amount', type: 'number' },
      { key: 'sanction_date', label: 'Sanction date', type: 'date' },
      { key: 'probable_pf_date', label: 'Probable PF date', type: 'date' },
      { key: 'interest_rate', label: 'Interest rate (%)', type: 'number' },
      { key: 'tenure_months', label: 'Tenure (months)', type: 'number' },
      { key: 'moratorium_months', label: 'Moratorium (months)', type: 'number' },
    ],
  },
  PF: {
    table: 'deal_pf_details',
    fields: [
      { key: 'pf_amount', label: 'PF amount', type: 'number' },
      { key: 'pf_date', label: 'PF date', type: 'date' },
      { key: 'probable_disbursement_date', label: 'Probable disbursement date', type: 'date' },
    ],
  },
};

let dealStageCache = null;
let dealStageStatusCache = null;
let holdReasonCache = null;
let rejectionReasonCache = null;
const branchCacheByLender = new Map();

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

export async function getLenderBranches(lenderId) {
  if (branchCacheByLender.has(lenderId)) return branchCacheByLender.get(lenderId);
  const { data, error } = await supabase
    .from('lender_branches')
    .select('id, name')
    .eq('lender_id', lenderId)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  branchCacheByLender.set(lenderId, data);
  return data;
}

export async function getLeadLenderStatusRows(leadId) {
  const { data, error } = await supabase
    .from('lead_lender_status')
    .select(`
      id, share_status, deal_id,
      lenders ( id, name ),
      deals (
        id, lender_branch_id,
        current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( id, name ),
        current_stage_status:deal_stage_statuses ( id, name )
      )
    `)
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('lenders(name)', { ascending: true });
  if (error) throw error;
  return data;
}

/** Starts a deal with a lender that has no loan officer yet — see the 011 migration. */
export async function startDeal(leadLenderStatusId, remarks) {
  const { data, error } = await supabase.rpc('share_lead_with_lender', {
    p_lead_lender_status_id: leadLenderStatusId,
    p_loan_officer_id: null,
    p_remarks: remarks || null,
  });
  if (error) throw error;
  return data;
}

export async function getDealDetail(dealId) {
  const { data: deal, error } = await supabase
    .from('deals')
    .select(`
      *,
      lenders ( id, name ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( id, name, sequence_order ),
      current_stage_status:deal_stage_statuses ( id, name ),
      hold_reason:deal_hold_reasons ( name ),
      rejection_reason:deal_rejection_reasons ( name )
    `)
    .eq('id', dealId)
    .single();
  if (error) throw error;

  const stageName = deal.current_deal_stage?.name;
  const stageConfig = STAGE_TABLE_MAP[stageName];
  let stageDetails = null;
  if (stageConfig) {
    const { data: detailRow, error: detailError } = await supabase
      .from(stageConfig.table)
      .select('*')
      .eq('deal_id', dealId)
      .maybeSingle();
    if (detailError) throw detailError;
    stageDetails = detailRow;
  }

  const { data: disbursements, error: disbError } = await supabase
    .from('disbursements')
    .select('*')
    .eq('deal_id', dealId)
    .eq('is_deleted', false)
    .order('tranche_number', { ascending: true });
  if (disbError) throw disbError;

  return { deal, stageDetails, disbursements };
}

export async function updateDealRegion(dealId, lenderBranchId) {
  const { error } = await supabase.from('deals').update({ lender_branch_id: lenderBranchId || null }).eq('id', dealId);
  if (error) throw error;
}

export async function updateStageDetails(stageName, dealId, fields) {
  const stageConfig = STAGE_TABLE_MAP[stageName];
  if (!stageConfig) throw new Error(`No editable fields for stage "${stageName}"`);
  const { error } = await supabase.from(stageConfig.table).update(fields).eq('deal_id', dealId);
  if (error) throw error;
}

export async function changeDealStage(dealId, newStageId, newStatusId, remarks) {
  const { error } = await supabase.rpc('change_deal_stage', {
    p_deal_id: dealId,
    p_new_stage_id: newStageId,
    p_new_status_id: newStatusId ?? null,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function putDealOnHold(dealId, holdReasonId, remarks) {
  const { error } = await supabase.rpc('put_deal_on_hold', {
    p_deal_id: dealId,
    p_hold_reason_id: holdReasonId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function releaseDealHold(dealId, remarks) {
  const { error } = await supabase.rpc('release_deal_hold', { p_deal_id: dealId, p_remarks: remarks ?? null });
  if (error) throw error;
}

export async function rejectDeal(dealId, rejectionReasonId, remarks) {
  const { error } = await supabase.rpc('reject_deal', {
    p_deal_id: dealId,
    p_rejection_reason_id: rejectionReasonId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function reinstateDeal(dealId, remarks) {
  const { error } = await supabase.rpc('reinstate_deal', { p_deal_id: dealId, p_remarks: remarks ?? null });
  if (error) throw error;
}

export async function recordDisbursement(dealId, trancheNumber, amount, disbursedDate, academicTerm, remarks) {
  const { error } = await supabase.rpc('record_disbursement', {
    p_deal_id: dealId,
    p_tranche_number: trancheNumber,
    p_amount: amount,
    p_disbursed_date: disbursedDate,
    p_academic_term: academicTerm ?? null,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}
