import { supabase } from '../config/supabaseClient.js';
import { createAuthService } from '../../../../shared/js/authService.js';

export const { signOut } = createAuthService(supabase);

export async function getCurrentUser() {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email, phone, is_active, roles ( name )')
    .eq('id', authData.user.id)
    .single();
  if (error) throw error;
  if (!data.is_active) throw new Error('DEACTIVATED');

  return { id: data.id, fullName: data.full_name, email: data.email, phone: data.phone, role: data.roles?.name ?? 'Unknown' };
}

export async function updateMyProfile({ fullName, phone }) {
  const { data: authData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('users')
    .update({ full_name: fullName, phone })
    .eq('id', authData.user.id);
  if (error) throw error;
}
