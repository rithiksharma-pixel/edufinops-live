// =========================================================
// SERVICE LAYER — Lead × Lender status matrix
// One row per lead per active lender (auto-seeded by a DB trigger on
// lead creation). Marking a row "Shared" calls share_lead_with_lender,
// which atomically creates the deal — this file never inserts into
// `deals` directly.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

let reasonCache = null;

export async function getNotSharedReasons() {
  if (reasonCache) return reasonCache;
  const { data, error } = await supabase
    .from('lead_lender_not_shared_reasons')
    .select('id, name')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name', { ascending: true });
  if (error) throw error;
  reasonCache = data;
  return data;
}

export async function getLenderStatusForLead(leadId) {
  const { data, error } = await supabase
    .from('lead_lender_status')
    .select(`
      id, share_status, not_shared_reason_id, not_shared_other_text, deal_id, updated_at,
      lenders ( id, name ),
      lead_lender_not_shared_reasons ( name ),
      updated_by_user:users!lead_lender_status_updated_by_fkey ( full_name ),
      deals ( id, current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name), assigned_loan_officer:users!deals_assigned_loan_officer_id_fkey(full_name) )
    `)
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('lenders(name)', { ascending: true });
  if (error) throw error;
  return data;
}

/** Sets/updates the "Not Shared" reason for a lender row. Does nothing to any deal. */
export async function updateNotSharedReason(rowId, reasonId, otherText) {
  const { error } = await supabase
    .from('lead_lender_status')
    .update({ not_shared_reason_id: reasonId || null, not_shared_other_text: otherText || null })
    .eq('id', rowId);
  if (error) throw error;
}

/**
 * Marks a row Shared and atomically creates the deal via the RPC —
 * requires the specific loan officer at that lender, since deal
 * visibility on the lender side is scoped to that one person.
 */
export async function shareLeadWithLender(rowId, loanOfficerId, remarks) {
  const { data, error } = await supabase.rpc('share_lead_with_lender', {
    p_lead_lender_status_id: rowId,
    p_loan_officer_id: loanOfficerId,
    p_remarks: remarks || null,
  });
  if (error) throw error;
  return data;
}
