-- =========================================================
-- 070 - Accepting an invitation brings a removed person back
--
-- Kavya and Rimsha were removed in Manage users, then re-invited. Both
-- accepted and signed in, and every screen then said "This account has been
-- deactivated". accept_my_invitation() inserted the profile with
--   on conflict (id) do nothing
-- so for someone who already had a (removed) profile, accepting logged an
-- "Activated" event and changed nothing: still is_deleted, still inactive.
--
-- Now accepting a fresh invitation restores the profile and applies what the
-- invitation says — role, manager, branch, phone, lender — because the
-- invitation is the Admin's latest word on who this person is.
--
-- The users guard trigger (guard_users_self_update) lets only an Admin change
-- role_id / is_active / is_deleted, and during accept the caller is the
-- invitee. accept_my_invitation() sets app.accepting_invitation for its own
-- transaction only, and the guard lets that one path through — the same
-- pattern as app.stage_automation for lead stages. The flag is transaction
-- local and can only be set from inside a function; PostgREST exposes no way
-- for a client to set it.
-- =========================================================

create or replace function public.guard_users_self_update()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  admin_only_cols text[] := array['role_id','is_active','is_deleted','lender_organization_id','lender_branch_id','consultancy_id','created_by','created_at'];
  manager_cols    text[] := array['team_id','reporting_manager_id'];
  col text;
begin
  if is_admin() or current_setting('app.accepting_invitation', true) = 'on' then
    return new;
  end if;

  foreach col in array admin_only_cols loop
    if (to_jsonb(old) ->> col) is distinct from (to_jsonb(new) ->> col) then
      raise exception 'Only an Admin can change %', col;
    end if;
  end loop;

  if not is_admin_or_manager() then
    foreach col in array manager_cols loop
      if (to_jsonb(old) ->> col) is distinct from (to_jsonb(new) ->> col) then
        raise exception 'Only an Admin or Manager can change %', col;
      end if;
    end loop;
  end if;

  return new;
end;
$function$;

create or replace function public.accept_my_invitation()
returns void language plpgsql security definer set search_path = public as $function$
declare
  v_invite invitations%rowtype;
  v_email text;
  v_team uuid;
begin
  v_email := lower(btrim(auth.jwt() ->> 'email'));
  if v_email is null or v_email = '' then
    raise exception 'No authenticated email found on this session';
  end if;

  -- Case-insensitive: 062 folded this in invite_user, but the accept side
  -- still compared raw text, so a differently-cased address found nothing.
  select * into v_invite from invitations
  where lower(btrim(email)) = v_email and status = 'pending'
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

  -- The branch follows the manager unless the invitation names one.
  v_team := coalesce(v_invite.team_id, (select team_id from users where id = v_invite.reporting_manager_id));

  perform set_config('app.accepting_invitation', 'on', true);

  insert into users (id, role_id, full_name, email, phone, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, created_by)
  values (auth.uid(), v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.phone, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_team, v_invite.invited_by)
  on conflict (id) do update
    set role_id = excluded.role_id,
        full_name = coalesce(nullif(btrim(excluded.full_name), ''), users.full_name),
        phone = coalesce(excluded.phone, users.phone),
        reporting_manager_id = excluded.reporting_manager_id,
        lender_organization_id = excluded.lender_organization_id,
        lender_branch_id = excluded.lender_branch_id,
        team_id = coalesce(excluded.team_id, users.team_id),
        is_active = true,
        is_deleted = false,
        updated_by = v_invite.invited_by;

  perform set_config('app.accepting_invitation', '', true);

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
  where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (auth.uid(), 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$function$;
