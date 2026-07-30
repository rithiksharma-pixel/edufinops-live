-- Run this once on an EXISTING project. Idempotent: every statement is
-- ALTER POLICY, safe to re-run.
--
-- Real bug, reported live: "new row violates row-level security policy
-- for table deal_bank_prospect_details" when a Manager shared a lead
-- with a lender.
--
-- Root cause: 009_associate_team_manager_role_migration widened
-- deals_insert to let Manager and Associate Team Manager create deals,
-- and gave can_view_deal() an explicit ATM branch — but every table that
-- a deal-creation/stage-change path writes to immediately afterward
-- (deal_bank_prospect_details, deal_login_details, deal_sanction_details,
-- deal_pf_details, deal_events, disbursements) still only allows
-- Admin/RM/Counselor/Lender-side on insert, and deals_update was never
-- widened either. share_lead_with_lender() and change_deal_stage() are
-- both security invoker, so RLS applies as the calling user — a Manager
-- or ATM could create the `deals` row, then fail on the very next insert.
-- Same wall blocks them from ever moving a deal through Login / Sanction
-- / PF / Disbursement, not just from the initial share.
--
-- The SELECT policies on all of these already read `using
-- (can_view_deal(deal_id))` with no per-role branching, so they already
-- worked correctly for Manager/ATM — only the branching INSERT/UPDATE
-- policies had the gap. Fixed by adding the same
-- `is_manager()`/`is_associate_team_manager()` branches every other
-- can_view_deal-scoped write policy already has (see
-- disbursements_write's existing is_rm()/is_counselor() branches for the
-- pattern being extended here).

alter policy deals_update on deals using (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_associate_team_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
  or (is_counselor() and assigned_counselor_id = auth.uid())
  or (is_lender_side() and assigned_loan_officer_id = auth.uid())
) with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_associate_team_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
  or (is_counselor() and assigned_counselor_id = auth.uid())
  or (is_lender_side() and assigned_loan_officer_id = auth.uid())
);

alter policy deal_bank_prospect_details_write on deal_bank_prospect_details with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
);
alter policy deal_bank_prospect_details_update on deal_bank_prospect_details using (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy deal_login_details_write on deal_login_details with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_login_details_update on deal_login_details using (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy deal_sanction_details_write on deal_sanction_details with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_sanction_details_update on deal_sanction_details using (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy deal_pf_details_write on deal_pf_details with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_pf_details_update on deal_pf_details using (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy deal_events_insert on deal_events with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy disbursements_write on disbursements with check (
  is_admin()
  or (is_manager() and can_view_deal(deal_id))
  or (is_associate_team_manager() and can_view_deal(deal_id))
  or (is_rm() and can_view_deal(deal_id))
  or (is_counselor() and can_view_deal(deal_id))
);
