// =========================================================
// SERVICE LAYER — Smart Views (saved lead-list filter combinations)
// Private per-user (RLS scopes every row to user_id = auth.uid()) —
// no admin-shared views in this pass.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export async function getSavedViews() {
  const { data, error } = await supabase
    .from('saved_views')
    .select('id, name, filters, sequence_order')
    .eq('is_deleted', false)
    .order('sequence_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createSavedView(name, filters, currentUserId) {
  const { data, error } = await supabase
    .from('saved_views')
    .insert({
      user_id: currentUserId,
      name,
      filters,
      created_by: currentUserId,
      updated_by: currentUserId,
    })
    .select('id, name, filters, sequence_order')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteSavedView(viewId) {
  const { error } = await supabase.from('saved_views').update({ is_deleted: true }).eq('id', viewId);
  if (error) throw error;
}
