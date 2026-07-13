import { supabase } from '../config/supabaseClient.js';

export async function getCurrentUser() {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email, is_active, roles ( name )')
    .eq('id', authData.user.id)
    .single();
  if (error) throw error;
  if (!data.is_active) throw new Error('DEACTIVATED');

  return { id: data.id, fullName: data.full_name, email: data.email, role: data.roles?.name ?? 'Unknown' };
}
