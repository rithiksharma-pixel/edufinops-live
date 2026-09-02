-- =========================================================
-- 062 — A resendable invitation
--
-- Onboarding was a dead end. invite_user refused a duplicate and told the
-- admin to "revoke it first", but there was no resend anywhere in the
-- product — so the only way forward was: close the dialog, find the invite,
-- revoke it, reopen the dialog, re-key every field, send again. The data
-- shows the cost: 38 invitations revoked against 36 ever accepted, and one
-- address invited four times in seven weeks.
--
-- Three fixes:
--
--   1. resend_invitation() — revoke and reissue in one call, carrying the
--      role, manager, team and phone forward so nothing is re-typed. The
--      revoke happens first so "one live invitation per email" is true at
--      every instant and a concurrent invite cannot slip between.
--
--   2. Email matching is now case-insensitive and trimmed. It was
--      `email = p_email`, so "Arun.Narayan@zolve.com" slipped straight past
--      the duplicate check and created a SECOND live invitation for the same
--      person. Emails are stored folded from here on.
--
--   3. Inviting an address that already has an account fails immediately
--      saying so, instead of creating an invitation that could never
--      usefully be accepted.
-- =========================================================

create or replace function public.resend_invitation(p_invitation_id uuid)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_old invitations%rowtype;
  v_new_id uuid;
begin
  if not (coalesce(is_admin(), false) or coalesce(is_manager(), false)
          or coalesce(is_associate_team_manager(), false)) then
    raise exception 'You are not authorized to resend invitations.' using errcode = '42501';
  end if;

  select * into v_old from invitations where id = p_invitation_id;
  if not found then
    raise exception 'That invitation no longer exists.' using errcode = 'P0002';
  end if;
  if v_old.status = 'accepted' then
    raise exception 'That invitation has already been accepted.' using errcode = '22023';
  end if;

  update invitations set status = 'revoked' where id = p_invitation_id;

  insert into invitations (email, full_name, phone, role_id, reporting_manager_id,
                           lender_organization_id, lender_branch_id, team_id, invited_by)
  values (lower(btrim(v_old.email)), v_old.full_name, v_old.phone, v_old.role_id,
          v_old.reporting_manager_id, v_old.lender_organization_id, v_old.lender_branch_id,
          v_old.team_id, auth.uid())
  returning id into v_new_id;

  return v_new_id;
end;
$function$;

-- Lets the invite dialog turn a duplicate into a one-click resend.
create or replace function public.pending_invitation_for(p_email text)
returns uuid language sql security definer set search_path to 'public' stable
as $function$
  select id from invitations
  where lower(btrim(email)) = lower(btrim(p_email))
    and status = 'pending' and expires_at > now()
  order by created_at desc limit 1;
$function$;

create or replace function public.invite_user(
  p_email text, p_full_name text, p_role_id uuid,
  p_reporting_manager_id uuid default null, p_lender_organization_id uuid default null,
  p_lender_branch_id uuid default null, p_team_id uuid default null, p_phone text default null)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_invitation_id uuid;
  v_role_name text;
  v_reporting_manager_id uuid := p_reporting_manager_id;
  v_team_id uuid := p_team_id;
  v_email text := lower(btrim(p_email));
begin
  if v_email = '' or v_email is null then
    raise exception 'An email address is required.' using errcode = '22023';
  end if;

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

  if exists (select 1 from users u
             where lower(btrim(u.email)) = v_email and not u.is_deleted) then
    raise exception '% already has an account. Reactivate them from the users list instead.', v_email
      using errcode = '23505';
  end if;

  if exists (select 1 from invitations
             where lower(btrim(email)) = v_email and status = 'pending' and expires_at > now()) then
    raise exception '% already has an invitation waiting. Use Resend on that row to send it again.', v_email
      using errcode = '23505';
  end if;

  insert into invitations (email, full_name, phone, role_id, reporting_manager_id,
                           lender_organization_id, lender_branch_id, team_id, invited_by)
  values (v_email, p_full_name, nullif(btrim(p_phone), ''), p_role_id, v_reporting_manager_id,
          p_lender_organization_id, p_lender_branch_id, v_team_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$function$;

revoke all on function public.resend_invitation(uuid) from public, anon;
revoke all on function public.pending_invitation_for(text) from public, anon;
grant execute on function public.resend_invitation(uuid) to authenticated;
grant execute on function public.pending_invitation_for(text) to authenticated;
