-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 030_lead_assignee_can_always_view).
-- Idempotent: CREATE OR REPLACE + DROP POLICY IF EXISTS.
--
-- Whoever holds a lead can see and work it, whatever their role.
--
-- Review feedback: "Show every name in Assigned RM list, might be possible
-- that manager or admin are handling that lead." Widening the picker on its
-- own would have silently lost leads. Verified BEFORE changing anything:
-- for a Manager, is_rm() is false and
-- rm_reports_to_current_manager(<their own id>) is false — so a lead whose
-- assigned_rm_id was that manager matched NO select policy. Invisible to
-- the very person it was handed to, and to their RMs. Only an Admin would
-- still have seen it.
--
-- Rather than special-casing each role, both layers now grant on the plain
-- fact of assignment:
--
--   can_view_lead()        gains a role-agnostic assignee branch, which
--                          fixes lead_events, documents, tasks and every
--                          other table routed through it.
--   leads_select_assignee  lets the assignee read the lead row.
--   leads_update_assignee  lets them actually work it, not just look at it.
--
-- Strictly additive — no existing grant is narrowed. Assigning a lead is
-- already an explicit act by an Admin/Manager, so treating it as intent to
-- grant access matches what the assignment means.
--
-- Verified after applying: a Manager handed a lead directly can read it,
-- read its timeline, and update it.

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
        -- Assignment alone is enough, regardless of role. Covers a Manager,
        -- ATM, Counselor or Admin personally holding a lead.
        or l.assigned_rm_id = auth.uid()
        or (is_manager() and (l.assigned_manager_id = auth.uid() or rm_reports_to_current_manager(l.assigned_rm_id)))
        or (is_associate_team_manager() and rm_reports_to_current_manager(l.assigned_rm_id))
        or (is_rm() and l.assigned_rm_id = auth.uid())
        or (is_source_role() and l.source_user_id = auth.uid())
        or (is_counselor() and (
              l.created_by = auth.uid()
              or exists (select 1 from deals d where d.lead_id = l.id and d.assigned_counselor_id = auth.uid())
            ))
      )
  )
$function$;

-- Scalar-subquery wrapping so the uid is evaluated once per query (InitPlan)
-- rather than once per row — same pattern as migration 019.
drop policy if exists leads_select_assignee on leads;
create policy leads_select_assignee on leads
  for select using (assigned_rm_id = (select auth.uid()));

drop policy if exists leads_update_assignee on leads;
create policy leads_update_assignee on leads
  for update using (assigned_rm_id = (select auth.uid()))
  with check (assigned_rm_id = (select auth.uid()));
