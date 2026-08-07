-- =========================================================
-- 044 — Managers and ATMs get Admin-level edit rights
--
-- A long tail of tables was is_admin() only, so a Manager could not maintain
-- consultancies, lenders, lender branches, TAT thresholds, teams, stages,
-- document types or any lookup list without pulling in an Admin.
--
-- Two of these were not "Admin-only config" at all, they were gaps:
--   co_applicants  a Manager could INSERT but not UPDATE (Admin/RM only)
--   tasks          only an Admin or the assignee could update, so a Manager
--                  could not close or reassign their own team's task
--
-- WHAT STAYS ADMIN-ONLY
--   users.role_id and users.is_active. A Manager who can set role_id can mint
--   an Admin, which is privilege escalation rather than edit access. Team and
--   reporting-manager ARE now Manager-editable, since maintaining the org
--   chart is exactly their job.
--
-- BOTH HALVES OF AN UPDATE POLICY MATTER
--   An UPDATE policy is evaluated twice: USING decides which rows you may
--   target, WITH CHECK decides whether the resulting row is permitted. The
--   first attempt at this migration changed only USING, and every write still
--   failed with "new row violates row-level security policy" because WITH
--   CHECK was left on is_admin(). Both are set below.
--
-- VERIFIED by role simulation, counting rows actually affected (a blocked
-- UPDATE returns 0 rows rather than raising, so an exception check alone
-- proves nothing):
--   Manager  consultancy 1 row, lender 1 row, TAT thresholds 5 rows,
--            team on a user 1 row, promote-to-Admin BLOCKED
--   RM       lenders 0 rows, TAT thresholds 0 rows  (correctly denied)
-- =========================================================

create or replace function public.is_admin_or_manager()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from users u join roles r on r.id = u.role_id
    where u.id = auth.uid()
      and u.is_active and not u.is_deleted
      and r.name in ('Admin','Manager','Associate Team Manager')
  );
$function$;

-- ---------- INSERT ----------
alter policy announcements_insert on public.announcements
  with check ((select is_admin_or_manager()) and created_by = auth.uid());
alter policy consultancies_insert on public.consultancies with check ((select is_admin_or_manager()));
alter policy deal_hold_reasons_admin_write on public.deal_hold_reasons with check ((select is_admin_or_manager()));
alter policy deal_rejection_reasons_admin_write on public.deal_rejection_reasons with check ((select is_admin_or_manager()));
alter policy deal_query_categories_write on public.deal_query_categories with check ((select is_admin_or_manager()));
alter policy deal_stage_statuses_admin_write on public.deal_stage_statuses with check ((select is_admin_or_manager()));
alter policy deal_stages_admin_write on public.deal_stages with check ((select is_admin_or_manager()));
alter policy document_types_admin_write on public.document_types with check ((select is_admin_or_manager()));
alter policy lead_lender_not_shared_reasons_insert on public.lead_lender_not_shared_reasons with check ((select is_admin_or_manager()));
alter policy lead_sources_admin_write on public.lead_sources with check ((select is_admin_or_manager()));
alter policy lead_stages_admin_write on public.lead_stages with check ((select is_admin_or_manager()));
alter policy lender_branches_write on public.lender_branches with check ((select is_admin_or_manager()));
alter policy lenders_admin_write on public.lenders with check ((select is_admin_or_manager()));
alter policy stage_tat_thresholds_admin_write on public.stage_tat_thresholds with check ((select is_admin_or_manager()));
alter policy teams_insert on public.teams with check ((select is_admin_or_manager()));
alter policy users_admin_write on public.users with check ((select is_admin_or_manager()));

-- ---------- UPDATE (USING and WITH CHECK together) ----------
alter policy announcements_update on public.announcements
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy consultancies_update on public.consultancies
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy deal_hold_reasons_admin_update on public.deal_hold_reasons
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy deal_rejection_reasons_admin_update on public.deal_rejection_reasons
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy deal_query_categories_update on public.deal_query_categories
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy deal_stage_statuses_admin_update on public.deal_stage_statuses
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy deal_stages_admin_update on public.deal_stages
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy document_types_admin_update on public.document_types
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy lead_lender_not_shared_reasons_update on public.lead_lender_not_shared_reasons
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy lead_sources_admin_update on public.lead_sources
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy lead_stages_admin_update on public.lead_stages
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy lender_branches_update on public.lender_branches
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy lenders_admin_update on public.lenders
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy stage_tat_thresholds_admin_update on public.stage_tat_thresholds
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy teams_update on public.teams
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));
alter policy notification_settings_update on public.notification_settings
  using ((select is_admin_or_manager())) with check ((select is_admin_or_manager()));

-- A Manager may edit people they can already SEE; the users SELECT policies
-- already scope that to themselves plus their own team.
alter policy users_admin_update on public.users
  using ((select is_admin_or_manager()) or id = (select auth.uid()))
  with check ((select is_admin_or_manager()) or id = (select auth.uid()));

alter policy co_applicants_update on public.co_applicants
  using ((select is_admin_or_manager()) or ((select is_rm()) and can_view_lead(lead_id)))
  with check ((select is_admin_or_manager()) or ((select is_rm()) and can_view_lead(lead_id)));

alter policy tasks_update on public.tasks
  using ((select is_admin_or_manager()) or assigned_to_user_id = (select auth.uid())
         or rm_reports_to_current_manager(assigned_to_user_id))
  with check ((select is_admin_or_manager()) or assigned_to_user_id = (select auth.uid())
         or rm_reports_to_current_manager(assigned_to_user_id));

-- ---------- the escalation guard ----------
create or replace function public.guard_users_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  admin_only_cols text[] := array['role_id','is_active','is_deleted','lender_organization_id','lender_branch_id','created_by','created_at'];
  manager_cols    text[] := array['team_id','reporting_manager_id'];
  col text;
begin
  if is_admin() then
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
