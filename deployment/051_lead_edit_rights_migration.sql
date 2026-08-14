-- =========================================================
-- 051 — Who may edit a lead, and who may change its stage
--
-- The rule you asked for:
--   Admin and Manager may edit ALL fields of any lead.
--   Only an Admin may change the lead STAGE.
--
-- STAGE WAS ALREADY CORRECT — nothing here changes it.
--   trg_guard_lead_stage_change rejects any direct change to
--   current_stage_id unless is_admin(), and change_lead_stage() raises the
--   same error. A Manager cannot set a stage today and still cannot after
--   this migration. Stage otherwise moves by itself from deal activity.
--
--   One deliberate exception stays: mark_lead_lost() lets whoever can edit
--   the lead mark it Lost, because that is an audited action that demands a
--   reason and writes a lead_events row. Taking it away would leave an RM
--   unable to close out their own dead leads, which is not what you asked
--   for. Say the word if you want that Admin-only too.
--
-- WHAT WAS ACTUALLY WRONG: edit rights were far wider than "Admin and
-- Manager". Two places short-circuited on is_internal_staff(), which
-- resolves to Admin, Manager, Associate Team Manager, RELATIONSHIP MANAGER
-- and COUNSELOR. So all 29 RMs could edit any of the 12,669 leads, not
-- just their own -- which also contradicts scoping Lead Management to an
-- RM's own book.
--
--   1. policy leads_update_internal_staff
--   2. function can_edit_lead(), used by mark_lead_lost() and friends
--
-- Both now use is_admin_or_manager() (Admin, Manager, Associate Team
-- Manager). RMs are unaffected on their OWN leads: leads_update_rm and
-- leads_update_assignee still grant that, and can_edit_lead() still returns
-- true for the assigned RM.
--
-- The deal_* and disbursements policies deliberately KEEP is_internal_staff.
-- RMs must record login / sanction / PF / disbursement details -- that is
-- the data entry which drives stage automation. Removing it would stop the
-- pipeline moving at all.
-- =========================================================

-- 1. Blanket edit of the lead record: Admin / Manager / ATM only.
alter policy leads_update_internal_staff on leads
  using ((select is_admin_or_manager()))
  with check ((select is_admin_or_manager()));

-- 2. Same narrowing inside the helper. The remaining branches already cover
--    "the RM this lead is assigned to" and "the manager this RM reports to",
--    so an RM keeps full edit of their own book.
create or replace function public.can_edit_lead(p_lead_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select (select is_admin_or_manager()) or exists (
    select 1 from leads l
    where l.id = p_lead_id
      and (is_admin() or l.assigned_rm_id = auth.uid()
           or (is_manager() and (l.assigned_manager_id = auth.uid() or rm_reports_to_current_manager(l.assigned_rm_id)))
           or (is_associate_team_manager() and rm_reports_to_current_manager(l.assigned_rm_id)))
  )
$function$;

comment on function public.can_edit_lead(uuid) is
  'True for Admin/Manager/ATM on any lead, or for the RM the lead is assigned to. Stage changes are governed separately and remain Admin-only.';
