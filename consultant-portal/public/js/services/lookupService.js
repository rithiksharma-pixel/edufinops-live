import { supabase } from '../config/supabaseClient.js';

export async function getLeadStages() {
  const { data, error } = await supabase
    .from('lead_stages')
    .select('id, name, sequence_order')
    .eq('is_deleted', false)
    .order('sequence_order');
  if (error) throw error;
  return data;
}

export async function getLeadSources() {
  const { data, error } = await supabase
    .from('lead_sources')
    .select('id, name, category')
    .eq('category', 'Consultant')
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name');
  if (error) throw error;
  return data;
}
