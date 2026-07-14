import { supabase } from '../config/supabaseClient.js';

export async function getCurrentUser() {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email, is_active, lender_organization_id, roles ( name ), lenders!users_lender_organization_id_fkey ( name )')
    .eq('id', authData.user.id)
    .single();
  if (error) throw error;
  if (!data.is_active) throw new Error('DEACTIVATED');
  if (data.roles?.name !== 'Lender') throw new Error('NOT_LENDER');

  return {
    id: data.id,
    fullName: data.full_name,
    email: data.email,
    role: data.roles?.name,
    lenderOrgId: data.lender_organization_id,
    lenderOrgName: data.lenders?.name ?? 'Unassigned',
  };
}
