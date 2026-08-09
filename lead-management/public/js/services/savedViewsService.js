// =========================================================
// SERVICE LAYER — Smart Views (saved lead-list filter combinations)
//
// Two kinds, both governed by RLS (048):
//   private  visible only to the user who made it
//   shared   published by an Admin/Manager, readable by everyone, so it shows
//            up as a tab for the whole team
// Nothing here decides that — the policy does. This file just reads what the
// caller is allowed to see and flags which is which for the UI.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export async function getSavedViews() {
  const { data, error } = await supabase
    .from('saved_views')
    .select('id, name, filters, sequence_order, is_shared, user_id')
    .eq('is_deleted', false)
    .order('is_shared', { ascending: false })
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
    .select('id, name, filters, sequence_order, is_shared, user_id')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteSavedView(viewId) {
  const { error } = await supabase.from('saved_views').update({ is_deleted: true }).eq('id', viewId);
  if (error) throw error;
}
