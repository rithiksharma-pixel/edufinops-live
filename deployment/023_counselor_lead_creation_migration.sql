-- Run this once on an EXISTING project that predates this file.
-- =========================================================
-- Counselors could see and click "New lead" in Lead Management (only
-- the 'Lender' role hides that button — see lead-management/public/js/app.js),
-- but no leads_insert_* policy has ever covered the Counselor role, in
-- this file or any prior migration. Every submission failed with a raw
-- RLS violation surfaced as a generic "Could not save this lead" toast.
--
-- Three pieces are needed to make the whole create-lead round trip work,
-- not just the initial insert:
--
-- 1. leads_insert_counselor — the missing INSERT policy itself.
--
-- 2. can_view_lead() gets an explicit Counselor branch (deal-assigned OR
--    self-created). This function has never had one — every existing
--    "(is_counselor() and can_view_lead(lead_id))" clause elsewhere in the
--    schema (lead_lender_status, document/storage policies, etc.) has
--    therefore always evaluated false for an actual Counselor. Adding the
--    branch here is a pure widening to what those call sites already
--    assumed was true, and is also required for #3 below.
--
-- 3. lead_events_insert — createLead() immediately writes a "Lead Created"
--    timeline event after the leads row; without a Counselor branch here
--    (there wasn't even a dead-code one), that second write would fail
--    RLS and surface as "Lead saved, but its timeline entry failed."
--
-- leads_select_counselor also needs to accept created_by = auth.uid(),
-- independently of can_view_lead(), since it is its own direct policy on
-- the leads table (not routed through the function) — without this, the
-- client's `.insert(...).select().single()` RETURNING read fails RLS on
-- the row a Counselor just inserted, the same class of bug already
-- handled for RM/Manager creators via assigned_rm_id/assigned_manager_id
-- (see the comment in lead-management/public/js/components/leadFormModal.js).
-- =========================================================

-- ---------- 1. Counselors can now insert leads ----------
create policy leads_insert_counselor on public.leads
  for insert
  with check ((select is_counselor()));

-- ---------- 2. can_view_lead() gains a real Counselor branch ----------
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
        or (is_counselor() and (
              l.created_by = auth.uid()
              or exists (select 1 from deals d where d.lead_id = l.id and d.assigned_counselor_id = auth.uid())
            ))
      )
  )
$function$;

-- ---------- 3. A Counselor can now see their own just-created lead row ----------
alter policy leads_select_counselor on public.leads
  using (
    (select is_counselor()) and (
      created_by = (select auth.uid())
      or exists (
        select 1 from deals d where d.lead_id = leads.id and d.assigned_counselor_id = (select auth.uid())
      )
    )
  );

-- ---------- 4. The opening "Lead Created" timeline event can now be written ----------
alter policy lead_events_insert on public.lead_events
  with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_associate_team_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_source_role() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
  );
