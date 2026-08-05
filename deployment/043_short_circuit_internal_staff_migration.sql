-- =========================================================
-- 043 — Stop paying can_view_lead() once per row on lead child tables
--
-- WHY THIS EXISTS
-- ---------------
-- can_view_lead() is a per-ROW function call. On lead_events (12,873 rows)
-- a plain count(*) took 9,603ms for a Manager. The statement_timeout on the
-- `authenticated` role is 8s, so that request did not merely crawl — it
-- returned HTTP 500. The Manager Dashboard reads lead_events, which is why
-- it was throwing errors rather than just feeling slow.
--
-- THE CHANGE
-- ----------
-- Put is_internal_staff() in front of can_view_lead(), wrapped in
-- (select ...) so Postgres evaluates it as an InitPlan ONCE per query
-- instead of once per row. When it is true the per-row call is skipped
-- entirely; when it is false the expression falls through unchanged.
--
-- BEHAVIOUR-NEUTRAL BY CONSTRUCTION
-- ---------------------------------
-- can_view_lead() already returns true for every internal staff member
-- (migration 038 added exactly that disjunct). So the hoisted check can only
-- be true where the original expression was already true — it cannot widen
-- access. For Consultant, BD and Lender is_internal_staff() is false and the
-- policy behaves exactly as before.
--
-- MEASURED
--   lead_events count(*), Manager:  9,603ms -> 2.9ms
--   Row counts unchanged: lead_events 12,873 and documents 14 for Admin,
--   Manager and RM alike.
--   Outside roles verified unchanged against a lead they do not own:
--     Consultant  0 events, 0 documents, 0 lender rows, 1 lead visible
--     Lender      0 events, 0 documents, 0 lender rows, 0 leads visible
--
-- lead_lender_status is included because it is the largest table in the
-- database at 202,623 rows. The app only ever reads it scoped .eq('lead_id'),
-- but an unbounded read by an internal user would previously have been
-- catastrophic rather than merely slow.
-- =========================================================

alter policy lead_events_select on public.lead_events
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy documents_select on public.documents
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy lead_lender_status_select on public.lead_lender_status
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy co_applicants_select on public.co_applicants
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy lead_academic_details_select on public.lead_academic_details
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy lead_parent_details_select on public.lead_parent_details
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy lead_collateral_details_select on public.lead_collateral_details
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy lead_references_select on public.lead_references
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy lead_university_choices_select on public.lead_university_choices
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy call_recordings_select on public.call_recordings
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy call_analyses_select on public.call_analyses
  using ((select is_internal_staff()) or can_view_lead(lead_id));

alter policy call_field_suggestions_select on public.call_field_suggestions
  using ((select is_internal_staff()) or can_view_lead(lead_id));
