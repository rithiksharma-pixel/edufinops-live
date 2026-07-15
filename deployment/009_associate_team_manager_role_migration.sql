-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- Adds a new "Associate Team Manager" (ATM) role that sits between
-- Manager ("Team Manager" in the user's own words) and Relationship
-- Manager in the reporting hierarchy:
--   Manager -> [0..N Associate Team Managers] -> [0..N RMs]
--   Manager -> [0..N RMs]  (RMs may still report directly to a Manager)
--
-- Mechanics:
--   1. New role row: 'Associate Team Manager'.
--   2. New helper is_associate_team_manager(), parallel to is_manager().
--   3. rm_reports_to_current_manager() becomes TRANSITIVE: it now
--      returns true both for a direct report AND for someone who
--      reports to an ATM who themselves reports to auth.uid(). This is
--      exactly right for BOTH callers that use this function:
--        - Manager caller: sees direct reports + RMs under their ATMs.
--        - ATM caller: sees only their own direct reports (the second,
--          "grandparent" clause never matches for an ATM caller, since
--          ATMs don't have their own subordinate ATMs).
--   4. can_view_lead()/can_view_deal() get an explicit ATM branch (many
--      other policies key off these two functions, so this alone
--      extends co_applicants, deals, documents, lead_academic_details,
--      lead_collateral_details, lead_parent_details, lead_references,
--      lead_university_choices, lead_events, storage.objects and
--      deal_events/deal_queries for free).
--   5. Every OTHER policy found via
--       select tablename, policyname, cmd, qual, with_check from pg_policies
--       where qual ilike '%is_manager%' or with_check ilike '%is_manager%'
--     gets an explicit, equivalently-scoped is_associate_team_manager()
--     branch (lookup/reference tables get unscoped parity with
--     is_counselor(); relationship-scoped tables get the ATM's own
--     direct-report scoping via the now-transitive
--     rm_reports_to_current_manager()).
--   6. invite_user() is opened up to Manager and Associate Team Manager,
--      each scoped to their own reporting subtree — see inline comments.
--
-- ASSUMPTION (flagged for review): Associate Team Managers get a
-- team_id like Managers do (defaulted to their inviting Manager's
-- team_id at invite time), so Team Performance rollups attribute their
-- RMs' numbers to the right team. See admin-dashboard/public/js/app.js
-- loadTeamPerformance(), which now also queries role IN ('Manager',
-- 'Associate Team Manager') when building its manager list.

-- ---------------------------------------------------------------------
-- 1. New role
-- ---------------------------------------------------------------------
insert into roles (name, description)
select 'Associate Team Manager', 'Reports to a Manager (Team Manager); manages a subset of that Manager''s Relationship Managers directly.'
where not exists (select 1 from roles where name = 'Associate Team Manager');

-- ---------------------------------------------------------------------
-- 2. Role-check helper
-- ---------------------------------------------------------------------
create or replace function public.is_associate_team_manager()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$ select auth_role() = 'Associate Team Manager' $function$;

-- ---------------------------------------------------------------------
-- 3. Make the RM->manager relationship check transitive (one extra hop
--    through an Associate Team Manager). Safe for both Manager and ATM
--    callers per the comment above.
-- ---------------------------------------------------------------------
create or replace function public.rm_reports_to_current_manager(rm_user_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from users u
    where u.id = rm_user_id
      and (
        u.reporting_manager_id = auth.uid()
        or exists (
          select 1 from users mgr
          where mgr.id = u.reporting_manager_id
            and mgr.reporting_manager_id = auth.uid()
        )
      )
  )
$function$;

-- ---------------------------------------------------------------------
-- 4. Central visibility functions get an explicit ATM branch
-- ---------------------------------------------------------------------
create or replace function public.can_view_lead(p_lead_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from leads l
    where l.id = p_lead_id
      and (
        is_admin()
        or (is_manager() and (l.assigned_manager_id = auth.uid() or rm_reports_to_current_manager(l.assigned_rm_id)))
        or (is_associate_team_manager() and rm_reports_to_current_manager(l.assigned_rm_id))
        or (is_rm() and l.assigned_rm_id = auth.uid())
        or (is_source_role() and l.source_user_id = auth.uid())
      )
  )
$function$;

create or replace function public.can_view_deal(p_deal_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from deals d
    where d.id = p_deal_id
      and (
        is_admin()
        or (is_manager() and can_view_lead(d.lead_id))
        or (is_associate_team_manager() and can_view_lead(d.lead_id))
        or (is_rm() and can_view_lead(d.lead_id))
        or (is_counselor() and d.assigned_counselor_id = auth.uid())
        or (is_lender_side() and d.assigned_loan_officer_id = auth.uid())
        or (is_lender_side() and exists (
              select 1 from deal_bank_prospect_details bpd
              where bpd.deal_id = d.id and bpd.bank_rm_id = auth.uid()
            ))
      )
  )
$function$;

-- ---------------------------------------------------------------------
-- 5. Every remaining policy that branches on is_manager() gets a
--    parallel is_associate_team_manager() branch.
-- ---------------------------------------------------------------------

-- Lookup/reference tables: unscoped parity, same shape as is_counselor().
alter policy deal_hold_reasons_select on deal_hold_reasons
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

alter policy deal_rejection_reasons_select on deal_rejection_reasons
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

alter policy deal_stage_statuses_select on deal_stage_statuses
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor() or is_lender_side());

alter policy deal_stages_select on deal_stages
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor() or is_lender_side());

alter policy document_types_select on document_types
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

alter policy lenders_select_non_consultant on lenders
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

-- can_view_lead()-scoped write policies.
alter policy co_applicants_write on co_applicants
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy deals_insert on deals
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy documents_insert on documents
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_counselor() and can_view_lead(lead_id)));

alter policy documents_select on documents
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_counselor() and can_view_lead(lead_id)));

alter policy documents_update on documents
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)))
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_academic_details_write on lead_academic_details
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_collateral_details_write on lead_collateral_details
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_events_insert on lead_events
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_source_role() and can_view_lead(lead_id)));

alter policy lead_lender_status_select on lead_lender_status
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_counselor() and can_view_lead(lead_id)));

alter policy lead_lender_status_update on lead_lender_status
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)))
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_parent_details_write on lead_parent_details
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_references_write on lead_references
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_university_choices_write on lead_university_choices
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

-- leads table itself.
alter policy leads_insert_manager on leads
  with check (is_manager() or is_associate_team_manager());

alter policy leads_select_manager on leads
  using (
    (is_manager() and ((assigned_manager_id = auth.uid()) or rm_reports_to_current_manager(assigned_rm_id)))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_rm_id))
  );

alter policy leads_update_manager on leads
  using (
    (is_manager() and ((assigned_manager_id = auth.uid()) or rm_reports_to_current_manager(assigned_rm_id)))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_rm_id))
  )
  with check (
    (is_manager() and ((assigned_manager_id = auth.uid()) or rm_reports_to_current_manager(assigned_rm_id)))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_rm_id))
  );

-- storage.objects (lead documents bucket).
alter policy lead_documents_insert on storage.objects
  with check (
    bucket_id = 'lead-documents'
    and (
      is_admin()
      or (is_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_associate_team_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_rm() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_counselor() and can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

alter policy lead_documents_select on storage.objects
  using (
    bucket_id = 'lead-documents'
    and (
      is_admin()
      or (is_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_associate_team_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_rm() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_counselor() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_lender_side() and exists (
            select 1 from deals d
            where d.lead_id = (storage.foldername(name))[1]::uuid
              and can_view_deal(d.id)
          ))
    )
  );

-- lead_assignments, tasks, user_role_events: rm_reports_to_current_manager()-scoped.
alter policy lead_assignments_insert on lead_assignments
  with check (is_admin() or is_manager() or is_associate_team_manager());

alter policy lead_assignments_select on lead_assignments
  using (
    is_admin()
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_rm() and (assigned_to_user_id = auth.uid()))
  );

alter policy tasks_insert on tasks
  with check (
    is_admin()
    or (assigned_to_user_id = auth.uid())
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

alter policy tasks_select on tasks
  using (
    is_admin()
    or (assigned_to_user_id = auth.uid())
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

alter policy user_role_events_select_manager on user_role_events
  using (
    (is_manager() and rm_reports_to_current_manager(user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(user_id))
  );

-- users table: lender-officer lookup parity, and manager/ATM "my team" visibility.
alter policy users_select_lender_officers_for_internal_staff on users
  using (
    (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor())
    and exists (select 1 from roles r where r.id = users.role_id and r.name = 'Lender')
  );

-- Upgraded to transitive: a Manager now also sees the Associate Team
-- Managers reporting to them AND the RMs reporting to those ATMs (not
-- just their own direct reports), matching rm_reports_to_current_manager()'s
-- new transitivity.
alter policy users_select_manager_team on users
  using (is_manager() and rm_reports_to_current_manager(id));

-- New: an Associate Team Manager sees their own direct reports' user
-- rows (for assignment dropdowns etc.) — one level only, this collapses
-- to a direct reporting_manager_id = auth.uid() check for an ATM caller.
create policy users_select_atm_team on users for select
  using (is_associate_team_manager() and rm_reports_to_current_manager(id));

-- ---------------------------------------------------------------------
-- 6. invite_user(): open up to Manager and Associate Team Manager, each
--    scoped to their own reporting subtree. Admin keeps unrestricted
--    rights. Every boolean role-check is wrapped in coalesce(x, false)
--    per the "if not coalesce(is_admin(), false)" fix from earlier
--    today — `if not NULL` silently doesn't raise in Postgres.
-- ---------------------------------------------------------------------
create or replace function public.invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null::uuid,
  p_lender_organization_id uuid default null::uuid,
  p_lender_branch_id uuid default null::uuid,
  p_team_id uuid default null::uuid
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
    -- Admin: unrestricted, any role, any reporting structure.
    null;

  elsif coalesce(is_manager(), false) then
    if v_role_name not in ('Relationship Manager', 'Counselor', 'Business Development', 'Associate Team Manager') then
      raise exception 'Managers can only invite Relationship Managers, Counselors, Business Development staff, or Associate Team Managers';
    end if;

    if v_reporting_manager_id is null then
      v_reporting_manager_id := auth.uid();
    end if;

    if v_role_name = 'Associate Team Manager' then
      -- An ATM you invite must report directly to you.
      if v_reporting_manager_id <> auth.uid() then
        raise exception 'Associate Team Managers you invite must report directly to you';
      end if;
    else
      -- RM/Counselor/BD may report to you, or to one of your own ATMs.
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

  insert into invitations (email, full_name, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, invited_by)
  values (p_email, p_full_name, p_role_id, v_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, v_team_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$function$;
