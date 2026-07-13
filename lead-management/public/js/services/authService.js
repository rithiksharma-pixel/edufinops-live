// =========================================================
// SERVICE LAYER — Authentication / current user context
// =========================================================
import { supabase } from '../config/supabaseClient.js';

let cachedProfile = null;

/**
 * Returns the current user's profile row (users table, joined to role name).
 * Cached for the session — call invalidateCurrentUser() after role changes.
 */
export async function getCurrentUser() {
  if (cachedProfile) return cachedProfile;

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) {
    throw new Error('Not authenticated');
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email, is_active, roles ( name )')
    .eq('id', authData.user.id)
    .single();

  if (error) throw error;

  cachedProfile = {
    id: data.id,
    fullName: data.full_name,
    email: data.email,
    isActive: data.is_active,
    role: data.roles?.name ?? 'Unknown',
  };
  return cachedProfile;
}

export function invalidateCurrentUser() {
  cachedProfile = null;
}

export async function signOut() {
  invalidateCurrentUser();
  await supabase.auth.signOut();
}
