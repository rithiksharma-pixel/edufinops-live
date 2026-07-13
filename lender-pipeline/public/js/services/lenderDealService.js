// =========================================================
// SERVICE LAYER — Lender-side deal management
// RLS (belongs_to_lender_org) already scopes every query here to
// deals shared with the current user's own lender organization —
// verified against Postgres, including the negative case (a
// different bank's officer sees zero rows on all of these).
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

export async function getMyBankDeals() {
  const { data, error } = await supabase
    .from('deals')
    .select(`
      id, is_on_hold, is_rejected, total_disbursed_amount,
      leads ( student_name, loan_amount_requested ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name, sequence_order ),
      current_stage_status:deal_stage_statuses ( name )
    `)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getDealDetail(dealId) {
  const { data: deal, error } = await supabase
    .from('deals')
    .select(`
      *,
      leads ( student_name, student_phone, course_name, university_name, loan_amount_requested ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( id, name, sequence_order )
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
    .order('tranche_number');
  if (disbError) throw disbError;

  return { deal, stageDetails, disbursements };
}

export async function getDealStages() {
  const { data, error } = await supabase.from('deal_stages').select('id, name, sequence_order').eq('is_deleted', false).order('sequence_order');
  if (error) throw error;
  return data;
}
export async function getDealHoldReasons() {
  const { data, error } = await supabase.from('deal_hold_reasons').select('id, name').eq('is_active', true);
  if (error) throw error;
  return data;
}
export async function getDealRejectionReasons() {
  const { data, error } = await supabase.from('deal_rejection_reasons').select('id, name').eq('is_active', true);
  if (error) throw error;
  return data;
}

export async function updateStageDetails(stageName, dealId, fields) {
  const config = STAGE_TABLE_MAP[stageName];
  if (!config) throw new Error(`No editable fields for stage "${stageName}"`);
  const { error } = await supabase.from(config.table).update(fields).eq('deal_id', dealId);
  if (error) throw error;
}

export async function changeDealStage(dealId, newStageId, remarks) {
  const { error } = await supabase.rpc('change_deal_stage', { p_deal_id: dealId, p_new_stage_id: newStageId, p_new_status_id: null, p_remarks: remarks ?? null });
  if (error) throw error;
}
export async function putDealOnHold(dealId, holdReasonId, remarks) {
  const { error } = await supabase.rpc('put_deal_on_hold', { p_deal_id: dealId, p_hold_reason_id: holdReasonId, p_remarks: remarks ?? null });
  if (error) throw error;
}
export async function releaseDealHold(dealId, remarks) {
  const { error } = await supabase.rpc('release_deal_hold', { p_deal_id: dealId, p_remarks: remarks ?? null });
  if (error) throw error;
}
export async function rejectDeal(dealId, rejectionReasonId, remarks) {
  const { error } = await supabase.rpc('reject_deal', { p_deal_id: dealId, p_rejection_reason_id: rejectionReasonId, p_remarks: remarks ?? null });
  if (error) throw error;
}
export async function reinstateDeal(dealId, remarks) {
  const { error } = await supabase.rpc('reinstate_deal', { p_deal_id: dealId, p_remarks: remarks ?? null });
  if (error) throw error;
}
export async function recordDisbursement(dealId, trancheNumber, amount, disbursedDate, academicTerm, remarks) {
  const { error } = await supabase.rpc('record_disbursement', { p_deal_id: dealId, p_tranche_number: trancheNumber, p_amount: amount, p_disbursed_date: disbursedDate, p_academic_term: academicTerm ?? null, p_remarks: remarks ?? null });
  if (error) throw error;
}

export async function getMyLenderProfile(lenderOrgId) {
  const { data, error } = await supabase
    .from('lenders')
    .select('id, name, code, contact_person_name, contact_email, contact_phone, registered_address, processing_notes')
    .eq('id', lenderOrgId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateMyLenderProfile(lenderOrgId, fields) {
  const { error } = await supabase.from('lenders').update(fields).eq('id', lenderOrgId);
  if (error) throw error;
}

/**
 * "Needs attention" = deal is on hold, rejected, or has had no stage
 * movement in 7+ days (a proxy for "stuck" since we don't want a second
 * round trip through deal_events just for a dashboard heuristic).
 * Everything else is "on track."
 */
export async function getDashboardSummary() {
  const { data, error } = await supabase
    .from('deals')
    .select(`
      id, is_on_hold, is_rejected, updated_at, total_disbursed_amount,
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name, sequence_order )
    `)
    .eq('is_deleted', false);
  if (error) throw error;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stageCounts = {};
  let needsAttention = 0, onTrack = 0, closedWon = 0;
  data.forEach((d) => {
    const stageName = d.current_deal_stage?.name || 'Unknown';
    stageCounts[stageName] = (stageCounts[stageName] || 0) + 1;
    if (stageName === 'Closed Won') closedWon += 1;
    const stuck = new Date(d.updated_at) < sevenDaysAgo && stageName !== 'Closed Won';
    if (d.is_on_hold || d.is_rejected || stuck) needsAttention += 1;
    else onTrack += 1;
  });

  return { totalDeals: data.length, needsAttention, onTrack, closedWon, stageCounts };
}

export async function getMessages(dealId) {
  const { data, error } = await supabase
    .from('lender_deal_messages')
    .select('id, message, created_at, sender:users ( full_name )')
    .eq('deal_id', dealId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}
export async function sendMessage(dealId, senderId, message) {
  const { error } = await supabase.from('lender_deal_messages').insert({ deal_id: dealId, sender_id: senderId, message, created_by: senderId });
  if (error) throw error;
}
