-- Run this once on an EXISTING project that predates this file.
--
-- Fixes a real RLS gap found while building the Manager Dashboard
-- "Unassigned Leads" section: leads created via consultant-portal
-- (createMyLead() in consultant-portal/public/js/services/leadService.js)
-- land with BOTH assigned_rm_id AND assigned_manager_id NULL — nothing
-- sets either column at creation time.
--
-- The existing leads_select_manager / leads_update_manager policies
-- only grant a Manager/Associate Team Manager visibility via:
--   (assigned_manager_id = auth.uid()) OR rm_reports_to_current_manager(assigned_rm_id)
-- Neither clause can ever match a row where both columns are NULL, so
-- NO manager could see or claim these leads at all. Verified via role
-- simulation before this migration: a real Manager saw 0 of the 4
-- genuinely-unassigned leads present in the table (all 4 were
-- invisible to every manager, not just scoped away from the wrong
-- one). The assign_lead() RPC failed the same way — its opening
-- `select ... for update` is itself subject to leads_select_manager,
-- so it would raise 'Lead % not found or not visible' for every
-- manager on every genuinely-unclaimed lead.
--
-- Fix: add an explicit "genuinely unclaimed" branch
-- (assigned_rm_id IS NULL AND assigned_manager_id IS NULL) to both
-- the SELECT policy and the UPDATE policy's USING/WITH CHECK clauses,
-- so any Manager/ATM can see and claim leads from this shared
-- unassigned pool. Once assigned (via the existing, unmodified
-- assign_lead() RPC), the lead falls under the normal
-- rm_reports_to_current_manager() scoping like every other lead — a
-- manager can still only assign it to an RM who reports to them,
-- since getAssignableRms() (RLS on `users`) and assign_lead()'s own
-- with_check already enforce that boundary.
--
-- Per this session's established pattern (is_manager() /
-- is_associate_team_manager() can return SQL NULL, not just false,
-- when auth_role() finds no matching public.users row), every
-- role-check call in the new policy text is wrapped in
-- coalesce(..., false).
--
-- Verified live via role simulation (see chat transcript):
--   1. Before: manager saw 0/4 unassigned leads.
--   2. After:  manager saw 1/4 (the 3 others already have an explicit
--      assigned_manager_id set to a DIFFERENT manager — correctly
--      still excluded; only the genuinely-unclaimed one became visible).
--   3. Full assign_lead(lead_id, rm_id, reason) RPC call succeeded
--      end-to-end inside a rolled-back transaction: assigned_rm_id
--      updated, lead_assignments + lead_events rows written, then
--      rolled back to leave production data untouched.

alter policy leads_select_manager on public.leads
using (
  (coalesce(is_manager(), false) and (
    (assigned_manager_id = auth.uid())
    or rm_reports_to_current_manager(assigned_rm_id)
    or (assigned_rm_id is null and assigned_manager_id is null)
  ))
  or
  (coalesce(is_associate_team_manager(), false) and (
    rm_reports_to_current_manager(assigned_rm_id)
    or (assigned_rm_id is null and assigned_manager_id is null)
  ))
);

alter policy leads_update_manager on public.leads
using (
  (coalesce(is_manager(), false) and (
    (assigned_manager_id = auth.uid())
    or rm_reports_to_current_manager(assigned_rm_id)
    or (assigned_rm_id is null and assigned_manager_id is null)
  ))
  or
  (coalesce(is_associate_team_manager(), false) and (
    rm_reports_to_current_manager(assigned_rm_id)
    or (assigned_rm_id is null and assigned_manager_id is null)
  ))
)
with check (
  (coalesce(is_manager(), false) and (
    (assigned_manager_id = auth.uid())
    or rm_reports_to_current_manager(assigned_rm_id)
    or (assigned_rm_id is null and assigned_manager_id is null)
  ))
  or
  (coalesce(is_associate_team_manager(), false) and (
    rm_reports_to_current_manager(assigned_rm_id)
    or (assigned_rm_id is null and assigned_manager_id is null)
  ))
);
