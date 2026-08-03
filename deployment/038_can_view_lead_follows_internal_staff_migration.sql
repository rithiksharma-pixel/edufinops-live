-- =========================================================
-- 038 — can_view_lead() must follow the same rule as the leads table
--
-- WHY THIS EXISTS
-- ---------------
-- 035 widened the `leads` policies so any internal staff member can see any
-- lead. It did not widen can_view_lead(), which still required the caller to
-- be assigned to the lead, to manage its RM, to have created it, or to be an
-- Admin.
--
-- Thirteen child tables gate on can_view_lead(): lead_lender_status,
-- documents, document_events, lead_events, co_applicants, lead_academic_details,
-- lead_parent_details, lead_collateral_details, lead_references,
-- lead_university_choices, lead_messages, deals (insert/update) and the
-- storage.objects policies for lead-documents.
--
-- So the parent opened and every child came back empty. Reproduced against
-- production as an RM on an unassigned lead:
--
--     can_open_lead    1        <- leads policy passes
--     lender_rows      0        <- "No lenders configured yet"
--     documents        0
--     timeline         0
--     co_applicants    0
--     academic         0
--
-- It reads as data loss after the migration. It is not — the rows are there
-- (that lead has all 17 lender rows seeded). They were unreadable.
--
-- WHAT CHANGES
-- ------------
-- One disjunct: is_internal_staff(). Child records now follow the parent,
-- which is what "open all leads to the team" was always supposed to mean.
--
-- This widens writes as well as reads, because can_view_lead() also backs the
-- update/insert policies on those tables. That is the intent — the team can
-- edit any field on any lead. Lead stage stays Admin-only, enforced separately
-- by trg_guard_lead_stage_change (035/036) and untouched here.
--
-- The existing disjuncts are kept rather than replaced. is_internal_staff()
-- does not cover Consultant or Business Development, and those roles still
-- reach their own leads through is_source_role() / created_by exactly as
-- before. Verified: a Consultant still sees zero rows on another's lead.
--
-- Idempotent: CREATE OR REPLACE, no data written.
-- =========================================================

create or replace function public.can_view_lead(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from leads l
    where l.id = p_lead_id
      and (
        is_admin()
        -- Any internal staff member may see any lead. This is the rule the
        -- `leads` table itself has enforced since 035; without it here, the
        -- lead opens but every child table reads as empty.
        or is_internal_staff()
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
