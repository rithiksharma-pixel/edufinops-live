-- =========================================================
-- 063 — Accounts that can authenticate but have nowhere to land
--
-- inviteUserByEmail creates the auth.users row up front. The public.users
-- profile is only created later, by accept_my_invitation(), which requires a
-- PENDING invitation. So when an admin revoked an invitation to work around
-- the "already pending" dead end (see 062) while the invited person had
-- already set a password, the profile was never created.
--
-- Those people sign in successfully -- /token returns 200 -- and then
-- getCurrentUser()'s .single() finds no profile and throws. login.js caught
-- that and showed "Incorrect email or password", so they retried a password
-- that was already correct, then asked for a reset that could not be sent.
-- Six accounts were in this state.
--
-- Three things here:
--   1. orphaned_logins() so the condition is visible from inside the product
--      rather than diagnosed from the outside every time.
--   2. repair_orphaned_profile() to create the missing profile from the
--      invitation that was actually issued. Admin-only, and it writes a
--      user_role_events row so the grant is on the record.
--   3. accept_my_invitation() now matches the email case-insensitively --
--      062 folded this in invite_user but missed the accept side.
-- =========================================================

create or replace function public.orphaned_logins()
returns table (email text, auth_created timestamptz, has_signed_in boolean,
               has_password boolean, invitation_status text, invited_as text)
language sql security definer set search_path to 'public' stable
as $function$
  select a.email::text, a.created_at, a.last_sign_in_at is not null,
         (a.encrypted_password is not null and a.encrypted_password <> ''),
         i.status::text, r.name::text
  from auth.users a
  left join lateral (
    select * from invitations inv
    where lower(btrim(inv.email)) = lower(btrim(a.email))
    order by inv.created_at desc limit 1
  ) i on true
  left join roles r on r.id = i.role_id
  where not exists (select 1 from public.users u where u.id = a.id)
    and public.is_admin()
  order by a.created_at;
$function$;

create or replace function public.repair_orphaned_profile(p_email text)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_auth auth.users%rowtype;
  v_invite invitations%rowtype;
  v_email text := lower(btrim(p_email));
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an Admin can repair a login.' using errcode = '42501';
  end if;

  select * into v_auth from auth.users
   where lower(btrim(email)) = v_email limit 1;
  if not found then
    raise exception 'No account exists for %.', v_email using errcode = 'P0002';
  end if;

  if exists (select 1 from public.users where id = v_auth.id) then
    raise exception '% already has a profile - nothing to repair.', v_email
      using errcode = '23505';
  end if;

  -- The most recent invitation, whatever its status: a revoked one still
  -- records the role and manager an admin actually chose for this person,
  -- and that intent is what is being restored.
  select * into v_invite from invitations
   where lower(btrim(email)) = v_email
   order by created_at desc limit 1;
  if not found then
    raise exception 'No invitation was ever issued for %, so there is no role to restore. Invite them instead.', v_email
      using errcode = 'P0002';
  end if;

  insert into users (id, role_id, full_name, email, phone, reporting_manager_id,
                     lender_organization_id, lender_branch_id, team_id, created_by)
  values (v_auth.id, v_invite.role_id, v_invite.full_name, v_email, v_invite.phone,
          v_invite.reporting_manager_id, v_invite.lender_organization_id,
          v_invite.lender_branch_id, v_invite.team_id, auth.uid());

  update invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_auth.id
   where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (v_auth.id, 'Activated', v_invite.role_id, v_invite.reporting_manager_id, auth.uid());

  return v_auth.id;
end;
$function$;

create or replace function public.accept_my_invitation()
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_invite invitations%rowtype;
  v_email text;
begin
  v_email := lower(btrim(auth.jwt() ->> 'email'));
  if v_email is null or v_email = '' then
    raise exception 'No authenticated email found on this session';
  end if;

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
    raise exception 'This invitation has expired - ask your admin to send a new one';
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

revoke all on function public.orphaned_logins() from public, anon;
revoke all on function public.repair_orphaned_profile(text) from public, anon;
grant execute on function public.orphaned_logins() to authenticated;
grant execute on function public.repair_orphaned_profile(text) to authenticated;
