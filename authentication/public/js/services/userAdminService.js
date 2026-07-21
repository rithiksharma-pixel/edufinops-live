import { supabase } from '../config/supabaseClient.js';

export async function getRoles() {
  const { data, error } = await supabase.from('roles').select('id, name').eq('is_deleted', false).order('name');
  if (error) throw error;
  return data;
}

export async function getAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email, phone, is_active, team_id, roles ( name ), reporting_manager:users!reporting_manager_id ( full_name )')
    .eq('is_deleted', false)
    .order('full_name');
  if (error) throw error;
  return data;
}

export async function getTeams() {
  const { data, error } = await supabase.from('teams').select('id, name').eq('is_deleted', false).order('name');
  if (error) throw error;
  return data;
}

/**
 * "Reporting manager" choices for the invite modal, scoped to who the
 * CURRENT user is actually allowed to invite under (mirrors invite_user()'s
 * RPC-level scoping — this is convenience/UX only, the RPC re-validates
 * regardless). currentUser is the { id, role } shape from
 * getCurrentUser().
 *   - Admin: unrestricted — any Manager, Associate Team Manager, or Admin.
 *   - Manager: themself, plus their own Associate Team Managers.
 *   - Associate Team Manager: themself only (RMs they invite always
 *     report directly to them).
 *   - anyone else: no valid choices.
 */
export async function getPossibleManagers(currentUser) {
  if (!currentUser || currentUser.role === 'Admin') {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, team_id, roles!inner(name)')
      .in('roles.name', ['Manager', 'Associate Team Manager', 'Admin'])
      .eq('is_active', true)
      .order('full_name');
    if (error) throw error;
    return data;
  }

  if (currentUser.role === 'Manager') {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, team_id, roles!inner(name)')
      .eq('roles.name', 'Associate Team Manager')
      .eq('reporting_manager_id', currentUser.id)
      .eq('is_active', true)
      .order('full_name');
    if (error) throw error;
    return [{ id: currentUser.id, full_name: `${currentUser.fullName} (you)`, roles: { name: 'Manager' } }, ...data];
  }

  if (currentUser.role === 'Associate Team Manager') {
    return [{ id: currentUser.id, full_name: `${currentUser.fullName} (you)`, roles: { name: 'Associate Team Manager' } }];
  }

  return [];
}

export async function getLenders() {
  const { data, error } = await supabase.from('lenders').select('id, name').eq('is_deleted', false).order('name');
  if (error) throw error;
  return data;
}

export async function getLenderBranches(lenderId) {
  const { data, error } = await supabase
    .from('lender_branches')
    .select('id, name')
    .eq('lender_id', lenderId)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name');
  if (error) throw error;
  return data;
}

export async function getPendingInvitations() {
  const { data, error } = await supabase
    .from('invitations')
    .select('id, email, full_name, phone, invited_at, expires_at, roles ( name )')
    .eq('status', 'pending')
    .order('invited_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Records the invitation, then calls the Edge Function that actually
 * sends the email via Supabase Admin API (requires service_role — not
 * something the client can do directly with the anon key). If your
 * Supabase project doesn't have that Edge Function deployed yet, this
 * will still create the invitations row; the email step will fail
 * loudly rather than silently, so it's obvious it needs deploying.
 */
export async function inviteUser({ email, fullName, phone, roleId, reportingManagerId, lenderOrganizationId, lenderBranchId, teamId }) {
  const { data: invitationId, error } = await supabase.rpc('invite_user', {
    p_email: email,
    p_full_name: fullName,
    p_phone: phone || null,
    p_role_id: roleId,
    p_reporting_manager_id: reportingManagerId || null,
    p_lender_organization_id: lenderOrganizationId || null,
    p_lender_branch_id: lenderBranchId || null,
    p_team_id: teamId || null,
  });
  if (error) throw error;

  const { error: fnError } = await supabase.functions.invoke('send-invite-email', {
    body: { invitationId, email, fullName },
  });
  if (fnError) {
    throw new Error('Invitation recorded, but the invite email failed to send. Check the send-invite-email Edge Function is deployed.');
  }

  return invitationId;
}

export async function revokeInvitation(invitationId) {
  const { error } = await supabase.rpc('revoke_invitation', { p_invitation_id: invitationId });
  if (error) throw error;
}

export async function changeUserRole(userId, newRoleId, remarks) {
  const { error } = await supabase.rpc('change_user_role', {
    p_target_user_id: userId,
    p_new_role_id: newRoleId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function changeReportingManager(userId, newManagerId, remarks) {
  const { error } = await supabase.rpc('change_reporting_manager', {
    p_target_user_id: userId,
    p_new_manager_id: newManagerId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function changeUserTeam(userId, teamId) {
  const { error } = await supabase.from('users').update({ team_id: teamId }).eq('id', userId);
  if (error) throw error;
}

export async function deactivateUser(userId, remarks) {
  const { error } = await supabase.rpc('deactivate_user', { p_target_user_id: userId, p_remarks: remarks ?? null });
  if (error) throw error;
}

export async function reactivateUser(userId, remarks) {
  const { error } = await supabase.rpc('reactivate_user', { p_target_user_id: userId, p_remarks: remarks ?? null });
  if (error) throw error;
}
