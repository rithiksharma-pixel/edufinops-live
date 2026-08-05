-- =========================================================
-- 042 — Drop four redundant SELECT policies on `leads`
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 035 gave every internal staff member SELECT on every lead via
-- leads_select_internal_staff. That made four other SELECT policies dead
-- weight: they can only ever grant rows internal_staff already grants.
--
-- One of them was very expensive. leads_select_manager calls
--     rm_reports_to_current_manager(assigned_rm_id)
-- which runs a subquery against `users`, and Postgres evaluated it ONCE PER
-- ROW across 11,951 leads — twice, since the ATM branch calls it too. A bare
--     select count(*) from leads
-- took 1,176ms for a Manager. Every screen that touches leads paid that,
-- several times per page load, per user. With the whole team on at once it
-- compounded into the hangs and timeouts the team was reporting.
--
-- MEASURED, per role, before and after. Counts identical:
--     Admin 11951   Manager 11951   RM 11951   Counselor 11951
--     Consultant 1  BD 0            Lender 0
--   Manager count(*): 1176ms -> 6.2ms
--
-- KEPT
--   leads_select_internal_staff  Admin/Manager/ATM/RM/Counselor -> all leads
--   leads_select_source          Consultant/BD -> leads they sourced
--   leads_select_assignee        anyone assigned, whatever their role
--
-- This is a pure deletion of redundancy. It widens nothing: every row these
-- four policies could return is still returned by one of the three kept.
-- =========================================================

drop policy if exists leads_select_admin     on public.leads;
drop policy if exists leads_select_manager   on public.leads;
drop policy if exists leads_select_rm        on public.leads;
drop policy if exists leads_select_counselor on public.leads;
