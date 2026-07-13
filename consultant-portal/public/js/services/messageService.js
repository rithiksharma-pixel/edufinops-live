import { supabase } from '../config/supabaseClient.js';

export async function getMessages(leadId) {
  const { data, error } = await supabase
    .from('lead_messages')
    .select('id, message, created_at, sender:users ( full_name )')
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function sendMessage(leadId, senderId, message) {
  const { error } = await supabase
    .from('lead_messages')
    .insert({ lead_id: leadId, sender_id: senderId, message, created_by: senderId });
  if (error) throw error;
}
