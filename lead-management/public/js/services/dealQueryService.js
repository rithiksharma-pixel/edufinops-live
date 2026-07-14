// =========================================================
// SERVICE LAYER — Deal queries (structured Lender <-> RM questions)
// RLS (can_view_deal) already scopes every query here to deals the
// current user can see — no client-side re-filtering needed.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export async function getQueryCategories() {
  const { data, error } = await supabase
    .from('deal_query_categories')
    .select('id, name')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name');
  if (error) throw error;
  return data;
}

export async function getQueriesForDeal(dealId) {
  const { data, error } = await supabase
    .from('deal_queries')
    .select('id, question, status, resolution, created_at, resolved_at, deal_query_categories(name), raised_by_user:users!deal_queries_raised_by_fkey(full_name), resolved_by_user:users!deal_queries_resolved_by_fkey(full_name)')
    .eq('deal_id', dealId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function raiseQuery(dealId, categoryId, question, currentUserId) {
  const { error } = await supabase.from('deal_queries').insert({
    deal_id: dealId,
    category_id: categoryId,
    question,
    raised_by: currentUserId,
    created_by: currentUserId,
    updated_by: currentUserId,
  });
  if (error) throw error;
}

export async function resolveQuery(queryId, resolution, currentUserId) {
  const { error } = await supabase
    .from('deal_queries')
    .update({ status: 'Resolved', resolution, resolved_by: currentUserId, resolved_at: new Date().toISOString(), updated_by: currentUserId })
    .eq('id', queryId);
  if (error) throw error;
}
