-- Run this once on an EXISTING project that predates this file.
-- =========================================================
-- RLS PERFORMANCE — wrap constant, no-arg role checks and auth.uid() in
-- scalar subqueries so Postgres evaluates them ONCE per query (as an
-- InitPlan) instead of once per row. STABLE alone isn't enough inside a
-- policy expression; the (select ...) wrapper is what forces hoisting.
--
-- Impact measured on ~1,400 leads / ~1,500 lead_events (role-simulated
-- count(*) scans):
--   leads      — Admin 2165ms→3ms, RM 2828ms→7ms, Manager 2537ms→177ms
--   lead_events— Admin 5ms (short-circuits can_view_lead for admins)
-- This is what was causing "canceling statement due to statement timeout"
-- once the imports pushed the tables past a few hundred rows.
--
-- Logic is unchanged everywhere — rm_reports_to_current_manager /
-- can_view_lead still take the per-row id, which genuinely varies.
-- =========================================================

alter policy leads_select_admin on public.leads
  using ((select is_admin()));

alter policy leads_select_rm on public.leads
  using ((select is_rm()) and (assigned_rm_id = (select auth.uid())));

alter policy leads_select_source on public.leads
  using ((select is_source_role()) and (source_user_id = (select auth.uid())));

alter policy leads_select_counselor on public.leads
  using ((select is_counselor()) and exists (
    select 1 from deals d where d.lead_id = leads.id and d.assigned_counselor_id = (select auth.uid())
  ));

alter policy leads_select_manager on public.leads
  using (
    ((select coalesce(is_manager(), false)) and (
      (assigned_manager_id = (select auth.uid()))
      or rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
    or
    ((select coalesce(is_associate_team_manager(), false)) and (
      rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
  );

alter policy lead_events_select on public.lead_events
  using ((select is_admin()) or can_view_lead(lead_id));

alter policy documents_select on public.documents
  using (
    (select is_admin())
    or ((select is_manager()) and can_view_lead(lead_id))
    or ((select is_associate_team_manager()) and can_view_lead(lead_id))
    or ((select is_rm()) and can_view_lead(lead_id))
    or ((select is_counselor()) and can_view_lead(lead_id))
  );
