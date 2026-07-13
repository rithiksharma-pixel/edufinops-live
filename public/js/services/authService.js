import { supabase } from '../config/supabaseClient.js';

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/**
 * Fetches the signed-in user's profile + role name, and checks is_active.
 * Throws a distinct error if the account has been deactivated, so the
 * caller can show a clear message instead of a generic auth failure.
 */
export async function getCurrentUserProfile() {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email, is_active, roles ( name )')
    .eq('id', authData.user.id)
    .single();
  if (error) throw error;

  if (!data.is_active) {
    await supabase.auth.signOut();
    throw new Error('DEACTIVATED');
  }

  return { id: data.id, fullName: data.full_name, email: data.email, role: data.roles?.name ?? 'Unknown' };
}

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/authentication/public/accept-invite.html',
  });
  if (error) throw error;
}

export async function confirmPasswordReset(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** Called right after an invited user sets their password for the first time. */
export async function acceptMyInvitation() {
  const { error } = await supabase.rpc('accept_my_invitation');
  if (error) throw error;
}
