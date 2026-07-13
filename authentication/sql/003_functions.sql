-- =========================================================
-- RPC FUNCTIONS — AUTHENTICATION
-- All SECURITY DEFINER + an explicit is_admin() check inside the
-- function body, since user_role_events has no direct insert policy
-- for anyone — these functions are the only way to write to it.
-- =========================================================

create or replace function invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can invite users';
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, invited_by)
  values (p_email, p_full_name, p_role_id, p_reporting_manager_id, auth.uid())
  returning id into v_invitation_id;

  -- NOTE: this function only records intent. The actual email send and
  -- auth.users row creation happens in a Supabase Edge Function using
  -- the service_role key (supabase.auth.admin.inviteUserByEmail), which
  -- the Admin UI calls right after this. See docs/README.md.
  return v_invitation_id;
end;
$$;

-- Called by the Edge Function (service_role context) once the invited
-- person has set their password and Supabase has created their
-- auth.users row. Creates the matching `users` profile row and closes
-- out the invitation.
create or replace function accept_invitation(
  p_invitation_id uuid,
  p_new_auth_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
begin
  select * into v_invite from invitations where id = p_invitation_id and status = 'pending' for update;
  if not found then
    raise exception 'Invitation % not found or already used', p_invitation_id;
  end if;
  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'Invitation % has expired', p_invitation_id;
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, created_by)
  values (p_new_auth_user_id, v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.invited_by);

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = p_new_auth_user_id
  where id = p_invitation_id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (p_new_auth_user_id, 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;

create or replace function revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an Admin can revoke invitations';
  end if;
  update invitations set status = 'revoked', revoked_at = now() where id = p_invitation_id and status = 'pending';
end;
$$;

-- =========================================================
-- accept_my_invitation — called by the INVITED USER themselves,
-- immediately after they set their password via the emailed invite
-- link (which gives them a valid Supabase session but no `users` row
-- yet, so no role and no other permissions). Matches on JWT email
-- rather than a passed-in invitation ID, so the invited person can't
-- accept an invitation that wasn't sent to them.
-- =========================================================
create or replace function accept_my_invitation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
  v_email text;
begin
  v_email := auth.jwt() ->> 'email';
  if v_email is null then
    raise exception 'No authenticated email found on this session';
  end if;

  select * into v_invite from invitations
  where email = v_email and status = 'pending'
  order by invited_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No pending invitation found for %', v_email;
  end if;

  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = v_invite.id;
    raise exception 'This invitation has expired — ask your admin to send a new one';
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, created_by)
  values (auth.uid(), v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.invited_by)
  on conflict (id) do nothing;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
  where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (auth.uid(), 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;

create or replace function change_user_role(
  p_target_user_id uuid,
  p_new_role_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can change a user''s role';
  end if;

  select role_id into v_old_role_id from users where id = p_target_user_id for update;
  if v_old_role_id is null then
    raise exception 'User % not found', p_target_user_id;
  end if;

  update users set role_id = p_new_role_id, updated_by = auth.uid() where id = p_target_user_id;

  insert into user_role_events (user_id, event_type, old_role_id, new_role_id, remarks, created_by)
  values (p_target_user_id, 'Role Changed', v_old_role_id, p_new_role_id, p_remarks, auth.uid());
end;
$$;

create or replace function change_reporting_manager(
  p_target_user_id uuid,
  p_new_manager_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_manager_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can change reporting managers';
  end if;

  select reporting_manager_id into v_old_manager_id from users where id = p_target_user_id for update;

  update users set reporting_manager_id = p_new_manager_id, updated_by = auth.uid() where id = p_target_user_id;

  insert into user_role_events (user_id, event_type, old_manager_id, new_manager_id, remarks, created_by)
  values (p_target_user_id, 'Manager Changed', v_old_manager_id, p_new_manager_id, p_remarks, auth.uid());
end;
$$;

create or replace function deactivate_user(
  p_target_user_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an Admin can deactivate a user';
  end if;

  update users set is_active = false, updated_by = auth.uid() where id = p_target_user_id;
  if not found then
    raise exception 'User % not found', p_target_user_id;
  end if;

  insert into user_role_events (user_id, event_type, remarks, created_by)
  values (p_target_user_id, 'Deactivated', p_remarks, auth.uid());
end;
$$;

create or replace function reactivate_user(
  p_target_user_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an Admin can reactivate a user';
  end if;

  update users set is_active = true, updated_by = auth.uid() where id = p_target_user_id;
  if not found then
    raise exception 'User % not found', p_target_user_id;
  end if;

  insert into user_role_events (user_id, event_type, remarks, created_by)
  values (p_target_user_id, 'Reactivated', p_remarks, auth.uid());
end;
$$;
