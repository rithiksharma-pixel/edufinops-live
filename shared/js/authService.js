// =========================================================
// SHARED SERVICE — Authentication / current user context
// Canonical implementation used by every app whose auth needs are just
// "get the signed-in user's basic profile + role." Apps that need extra
// joined data (e.g. lender-pipeline's lender org, consultant-portal's
// updateMyProfile) keep their own authService.js instead of forcing a
// kitchen-sink API here.
//
// Exported as a factory (not a singleton) so each app supplies its OWN
// already-configured supabase client — every app keeps its own
// config/supabaseClient.js, so this never spins up a second competing
// GoTrueClient instance on the page. Usage from an app's authService.js:
//
//   import { supabase } from '../config/supabaseClient.js';
//   import { createAuthService } from '<path-to>/shared/js/authService.js';
//   export const { signIn, signOut, getCurrentUser, invalidateCurrentUser,
//     requestPasswordReset, confirmPasswordReset, acceptMyInvitation } = createAuthService(supabase);
// =========================================================

export function createAuthService(supabase) {
  let cachedProfile = null;

  function invalidateCurrentUser() {
    cachedProfile = null;
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    invalidateCurrentUser();
    await supabase.auth.signOut();
  }

  /**
   * Fetches the signed-in user's profile + role name, caching it for the
   * session (call invalidateCurrentUser() after role changes). Throws
   * 'DEACTIVATED' (after force-signing-out) if the account has been
   * deactivated, so callers show a clear message instead of a generic
   * auth failure or — worse — silently letting a deactivated user through.
   */
  async function getCurrentUser() {
    if (cachedProfile) return cachedProfile;

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

    cachedProfile = { id: data.id, fullName: data.full_name, email: data.email, role: data.roles?.name ?? 'Unknown' };
    return cachedProfile;
  }

  async function requestPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/authentication/public/accept-invite.html',
    });
    if (error) throw error;
  }

  async function confirmPasswordReset(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  /** Called right after an invited user sets their password for the first time. */
  async function acceptMyInvitation() {
    const { error } = await supabase.rpc('accept_my_invitation');
    if (error) throw error;
  }

  return {
    signIn,
    signOut,
    getCurrentUser,
    invalidateCurrentUser,
    requestPasswordReset,
    confirmPasswordReset,
    acceptMyInvitation,
  };
}
