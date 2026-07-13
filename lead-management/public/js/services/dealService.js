// =========================================================
// SERVICE LAYER — Deals (formerly "lender applications")
// One deal per lead-per-lender. Progress is stage + stage-status,
// with On Hold / Rejected as orthogonal overlay states. Stage-specific
// fields live in their own child tables (see STAGE_TABLE_MAP).
// =========================================================
import { supabase } from '../config/supabaseClient.js';

// Maps a deal_stages.name to its detail table and the columns that
// table owns. Single source of truth for both fetching and rendering
// the stage-specific form — see components/dealPanel.js.
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

export async function getDealsForLead(leadId) {
  const { data, error } = await supabase
    .from('deals')
    .select(`
      id, is_on_hold, hold_date, hold_remarks, is_rejected, rejection_date, rejection_remarks,
      total_disbursed_amount, final_disbursement_date,
      lenders ( name ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( id, name, sequence_order ),
      current_stage_status:deal_stage_statuses ( name ),
      hold_reason:deal_hold_reasons ( name ),
      rejection_reason:deal_rejection_reasons ( name ),
      assigned_counselor:users!deals_assigned_counselor_id_fkey ( full_name ),
      assigned_loan_officer:users!deals_assigned_loan_officer_id_fkey ( full_name )
    `)
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function getDealDetail(dealId) {
  const { data: deal, error } = await supabase
    .from('deals')
    .select(`
      *,
      lenders ( name ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( id, name, sequence_order ),
      current_stage_status:deal_stage_statuses ( name )
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

export async function getDealEvents(dealId) {
  const { data, error } = await supabase
    .from('deal_events')
    .select('*, from_stage:deal_stages!deal_events_from_stage_id_fkey(name), to_stage:deal_stages!deal_events_to_stage_id_fkey(name)')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createDeal({ leadId, lenderId, assignedCounselorId, assignedLoanOfficerId }, firstStageId, currentUserId) {
  const { data: deal, error } = await supabase
    .from('deals')
    .insert({
      lead_id: leadId,
      lender_id: lenderId,
      current_deal_stage_id: firstStageId,
      assigned_counselor_id: assignedCounselorId || null,
      assigned_loan_officer_id: assignedLoanOfficerId || null,
      created_by: currentUserId,
      updated_by: currentUserId,
    })
    .select()
    .single();
  if (error) throw error;

  // Seed the Bank Prospect detail row so the form has something to edit immediately
  const { error: detailError } = await supabase.from('deal_bank_prospect_details').insert({ deal_id: deal.id });
  if (detailError) throw new Error(`Deal created, but its Bank Prospect details failed to initialize: ${detailError.message}`);

  const { error: eventError } = await supabase.from('deal_events').insert({
    deal_id: deal.id,
    event_type: 'Deal Created',
    to_stage_id: firstStageId,
    created_by: currentUserId,
  });
  if (eventError) throw new Error(`Deal created, but its opening timeline entry failed: ${eventError.message}`);

  return deal;
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
