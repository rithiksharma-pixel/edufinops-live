-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 024_master_data_view).
-- CREATE OR REPLACE, so re-running is safe.
--
-- v_master_data — one flat row per lead, or per lead-lender deal where
-- deals exist, with every field the CRM captures and all foreign keys
-- resolved to readable names (~140 columns).
--
-- A lead with no deal still appears exactly once (LEFT JOIN), so this
-- doubles as the full lead master. A lead sent to three lenders appears
-- three times; the deal columns are what differ.
--
-- Stage dates live in per-stage detail tables, not on `deals`:
--   login_date    -> deal_login_details
--   sanction_date -> deal_sanction_details
--   pf_date       -> deal_pf_details
--   final_disbursement_date -> deals
--
-- SECURITY: a view runs as its OWNER by default, which would bypass RLS
-- and hand every lead to every user. security_invoker = on makes it run
-- as the CALLER, so all leads/deals policies still apply. Verified live:
-- RM 133 rows, Consultant 1, Admin 1535.

create or replace view v_master_data
with (security_invoker = on) as
select
  l.id as lead_id, d.id as deal_id,

  -- student
  l.student_name, l.student_phone, l.student_email, l.student_dob,
  l.gender, l.marital_status, l.citizenship,
  l.pan_number, l.aadhaar_number, l.passport_number, l.alternate_phone,

  -- course / destination
  l.course_name, l.degree, l.university_name, l.destination_country,
  l.intake_month, l.intake_year, l.admission_offer_status, l.total_study_cost,

  -- loan ask
  l.loan_amount_requested, l.currency, l.loan_type,
  l.applicant_financial_status, l.coapplicant_financial_status,
  l.have_cosigner, l.cosigner_relationship, l.self_funds_available,
  l.agricultural_income, l.employment_status, l.credit_score,
  l.savings_amount, l.has_liabilities, l.liabilities_amount,

  -- pipeline
  ls.name as lead_stage, ls.sequence_order as lead_stage_order,
  src.name as lead_source, src.category as lead_source_category,
  coalesce(cons.name, l.consultancy_other_name) as consultancy,
  rm.full_name as assigned_rm, mgr.full_name as assigned_manager,
  tm.name as team, su.full_name as sourced_by,
  l.priority, l.next_follow_up_at, l.last_activity_at,
  llr.name as lost_reason, l.lost_remarks,

  -- addresses
  l.current_address, l.current_city, l.current_state, l.current_country, l.current_pincode,
  l.permanent_address, l.permanent_city, l.permanent_state, l.permanent_country, l.permanent_pincode,

  -- academics
  ac.highest_qualification, ac.tenth_score, ac.twelfth_score,
  ac.ug_college_name, ac.ug_course_name, ac.ug_cgpa, ac.ug_graduation_year, ac.ug_backlogs,
  ac.pg_college_name, ac.pg_course_name, ac.pg_cgpa,
  ac.english_test_taken, ac.aptitude_test_taken,
  ac.course_duration_months, ac.scholarship_offered, ac.scholarship_amount,

  -- parents
  pa.father_first_name, pa.father_last_name, pa.father_mobile, pa.father_email,
  pa.mother_first_name, pa.mother_last_name, pa.mother_mobile, pa.mother_email,
  l.parent_alternate_number,

  -- co-applicant (earliest on record)
  ca.full_name as coapplicant_name, ca.relationship_to_student as coapplicant_relationship,
  ca.phone as coapplicant_phone, ca.email as coapplicant_email, ca.pan_number as coapplicant_pan,
  ca.employment_type as coapplicant_employment_type, ca.employer_name as coapplicant_employer,
  ca.designation as coapplicant_designation, ca.annual_income as coapplicant_annual_income,
  ca.monthly_net_income as coapplicant_monthly_net_income,
  ca.credit_score as coapplicant_credit_score, ca.bank_name as coapplicant_bank,

  -- collateral
  co.security_offered, co.security_type,
  co.current_value as collateral_value, co.owned_by as collateral_owner,

  -- deal / lender
  lnd.name as lender, lb.name as lender_branch,
  dstg.name as deal_stage, dss.name as deal_stage_status,
  lo.full_name as loan_officer, cns.full_name as counselor,
  d.is_on_hold, d.hold_date, dhr.name as hold_reason, d.hold_remarks,
  d.is_rejected, d.rejection_date, drr.name as rejection_reason, d.rejection_remarks,
  d.remarks as deal_remarks,

  -- stage details
  bp.region_shared_date, bp.sm_shared_date, bp.rm_shared_date,
  bp.eligibility_status, bp.remarks as bank_prospect_remarks,
  dl.login_date, dl.login_id, dl.login_amount, dl.loan_required_amount, dl.probable_sanction_date,
  sn.sanction_date, sn.sanction_amount, sn.interest_rate, sn.tenure_months,
  sn.moratorium_months, sn.probable_pf_date,
  pf.pf_date, pf.pf_amount, pf.probable_disbursement_date,
  d.final_disbursement_date, d.total_disbursed_amount,

  -- audit
  l.created_at as lead_created_at, l.updated_at as lead_updated_at,
  d.created_at as deal_created_at, d.updated_at as deal_updated_at

from leads l
left join deals d                    on d.lead_id = l.id and d.is_deleted = false
left join lead_stages ls             on ls.id = l.current_stage_id
left join lead_sources src           on src.id = l.lead_source_id
left join consultancies cons         on cons.id = l.consultancy_id
left join lead_lost_reasons llr      on llr.id = l.lost_reason_id
left join users rm                   on rm.id = l.assigned_rm_id
left join users mgr                  on mgr.id = l.assigned_manager_id
left join users su                   on su.id = l.source_user_id
left join teams tm                   on tm.id = rm.team_id
left join lead_academic_details ac   on ac.lead_id = l.id and ac.is_deleted = false
left join lead_parent_details pa     on pa.lead_id = l.id and pa.is_deleted = false
-- a lead can have several co-applicants / collateral rows; pick one
-- deterministically so the row count stays one-per-lead-per-deal
left join lateral (
  select * from co_applicants x
  where x.lead_id = l.id and x.is_deleted = false
  order by x.created_at, x.id limit 1
) ca on true
left join lateral (
  select * from lead_collateral_details x
  where x.lead_id = l.id and x.is_deleted = false
  order by x.created_at, x.id limit 1
) co on true
left join lenders lnd                on lnd.id = d.lender_id
left join lender_branches lb         on lb.id = d.lender_branch_id
left join deal_stages dstg           on dstg.id = d.current_deal_stage_id
left join deal_stage_statuses dss    on dss.id = d.current_stage_status_id
left join deal_hold_reasons dhr      on dhr.id = d.hold_reason_id
left join deal_rejection_reasons drr on drr.id = d.rejection_reason_id
left join users lo                   on lo.id = d.assigned_loan_officer_id
left join users cns                  on cns.id = d.assigned_counselor_id
left join deal_bank_prospect_details bp on bp.deal_id = d.id and bp.is_deleted = false
left join deal_login_details dl      on dl.deal_id = d.id and dl.is_deleted = false
left join deal_sanction_details sn   on sn.deal_id = d.id and sn.is_deleted = false
left join deal_pf_details pf         on pf.deal_id = d.id and pf.is_deleted = false
where l.is_deleted = false;

comment on view v_master_data is
  'Flat master export: one row per lead, or per lead-lender deal where deals exist. All FKs resolved to names. security_invoker so RLS applies to the caller.';
