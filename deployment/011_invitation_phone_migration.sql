-- Run this once on an EXISTING project that predates this file.
--
-- Captures a phone number during onboarding so a new user (especially a
-- Lender officer) has a contact number on record from day one, rather
-- than only an email. No SMS is sent — texting the portal link needs an
-- SMS provider account, which is a separate decision; this just makes
-- sure the number is captured now so it's there when that lands.
--
-- users.phone already exists (nullable) — only invitations was missing it,
-- so the number had nowhere to live between "invited" and "accepted".
--
-- NOTE on the drop: invite_user's existing signature ends in DEFAULT
-- params, so `create or replace` with an extra p_phone argument would
-- register a SECOND overload rather than replacing it, and PostgREST
-- would then have two candidates to pick between. The old signature is
-- dropped explicitly first so exactly one invite_user survives.

alter table invitations add column if not exists phone text;

drop function if exists public.invite_user(text, text, uuid, uuid, uuid, uuid, uuid);

create or replace function public.invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null,
  p_lender_organization_id uuid default null,
  p_lender_branch_id uuid default null,
  p_team_id uuid default null,
  p_phone text default null
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invitation_id uuid;
  v_role_name text;
  v_reporting_manager_id uuid := p_reporting_manager_id;
  v_team_id uuid := p_team_id;
begin
  select name into v_role_name from roles where id = p_role_id and is_deleted = false;
  if v_role_name is null then
    raise exception 'Unknown role';
  end if;

  if coalesce(is_admin(), false) then
    null;

  elsif coalesce(is_manager(), false) then
    if v_role_name not in ('Relationship Manager', 'Counselor', 'Business Development', 'Associate Team Manager') then
      raise exception 'Managers can only invite Relationship Managers, Counselors, Business Development staff, or Associate Team Managers';
    end if;

    if v_reporting_manager_id is null then
      v_reporting_manager_id := auth.uid();
    end if;

    if v_role_name = 'Associate Team Manager' then
      if v_reporting_manager_id <> auth.uid() then
        raise exception 'Associate Team Managers you invite must report directly to you';
      end if;
    else
      if not (
        v_reporting_manager_id = auth.uid()
        or exists (
          select 1 from users u
          join roles r on r.id = u.role_id
          where u.id = v_reporting_manager_id
            and u.reporting_manager_id = auth.uid()
            and r.name = 'Associate Team Manager'
            and u.is_deleted = false
        )
      ) then
        raise exception 'You can only invite users who will report to you or to one of your own Associate Team Managers';
      end if;
    end if;

    if v_team_id is null then
      select team_id into v_team_id from users where id = auth.uid();
    end if;

  elsif coalesce(is_associate_team_manager(), false) then
    if v_role_name not in ('Relationship Manager', 'Counselor', 'Business Development') then
      raise exception 'Associate Team Managers can only invite Relationship Managers, Counselors, or Business Development staff';
    end if;

    if v_reporting_manager_id is null then
      v_reporting_manager_id := auth.uid();
    end if;
    if v_reporting_manager_id <> auth.uid() then
      raise exception 'Associate Team Managers can only invite users who report directly to them';
    end if;

    if v_team_id is null then
      select team_id into v_team_id from users where id = auth.uid();
    end if;

  else
    raise exception 'You are not authorized to invite users';
  end if;

  if exists (select 1 from invitations where email = p_email and status = 'pending' and expires_at > now()) then
    raise exception 'There is already a pending invitation for %. Revoke it first if you need to resend.', p_email;
  end if;

  insert into invitations (email, full_name, phone, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, invited_by)
  values (p_email, p_full_name, nullif(btrim(p_phone), ''), p_role_id, v_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, v_team_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$function$;

-- Both accept paths carry the captured phone onto the new users row.
create or replace function public.accept_invitation(p_invitation_id uuid, p_new_auth_user_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  insert into users (id, role_id, full_name, email, phone, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, created_by)
  values (p_new_auth_user_id, v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.phone, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_invite.team_id, v_invite.invited_by);

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = p_new_auth_user_id
  where id = p_invitation_id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (p_new_auth_user_id, 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$function$;

create or replace function public.accept_my_invitation()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  insert into users (id, role_id, full_name, email, phone, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, created_by)
  values (auth.uid(), v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.phone, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_invite.team_id, v_invite.invited_by)
  on conflict (id) do nothing;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
  where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (auth.uid(), 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$function$;
