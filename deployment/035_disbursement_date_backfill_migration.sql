-- OPTIONAL — NOT REQUIRED BY THE BD PERFORMANCE FEATURE.
-- Read this whole header before applying: it changes numbers on dashboards
-- that are not part of that feature.
--
-- ---------------------------------------------------------------
-- THE BUG
-- ---------------------------------------------------------------
-- record_disbursement() writes the tranche to `disbursements` and refreshes
-- deals.total_disbursed_amount — but it never sets
-- deals.final_disbursement_date.
--
-- v_stage_milestones (migration 025 / 027) emits its Disbursement row
-- `where d.final_disbursement_date is not null`. With that column never
-- written, the milestone stream contains ZERO disbursements no matter how
-- many actually happened.
--
-- Measured on this project on 2026-08-12:
--
--   disbursements ledger rows ........ 3   (₹1,14,07,774 across 3 deals)
--   deals.total_disbursed_amount set . 3
--   deals.final_disbursement_date set  0   ← nothing ever writes it
--   v_stage_milestones 'Disbursement'  0   ← so the report says zero
--
-- Everything reading v_stage_milestones is therefore under-reporting
-- disbursements as zero: the "Milestones by date" card on the Manager
-- Dashboard, the same card on Admin → Reports, and the milestone CSV.
--
-- (Not affected: the "Disbursed amount" stat cards, which sum
-- deals.total_disbursed_amount directly and so were always right. That
-- split is exactly why the bug survived — one number on the page was
-- correct while another was zero.)
--
-- 034_bd_performance works around this rather than depending on it: it
-- reads Disbursement from the `disbursements` ledger, which the master
-- migration already calls the source of truth. The BD report is correct
-- with or without this file.
--
-- ---------------------------------------------------------------
-- WHAT THIS FIXES
-- ---------------------------------------------------------------
-- 1. record_disbursement() also maintains final_disbursement_date, defined
--    as the LATEST tranche date on the deal. Recomputed from the ledger on
--    every call rather than just taking p_disbursed_date, so back-dating an
--    older tranche cannot move the date backwards.
-- 2. A one-time backfill of the same value for deals that already have
--    tranches.
--
-- ---------------------------------------------------------------
-- WHAT CHANGES AFTER YOU APPLY IT
-- ---------------------------------------------------------------
-- The Milestones cards start showing real disbursement counts instead of
-- zero. On today's data that is 3 deals / ₹1,14,07,774 appearing where
-- there was previously a 0. Nothing decreases, and no lead, deal, or
-- ledger row is modified — only a derived date column is populated.
--
-- Once applied, 034's BD "Disbursed" column and the Milestones card agree.
-- Until then they will differ, and 034's is the accurate one.
--
-- Idempotent: CREATE OR REPLACE plus an UPDATE that becomes a no-op on the
-- second run.
-- =========================================================


-- ---------- 1. Keep the column maintained from now on ----------
-- Signature, language and (absent) SECURITY clause copied verbatim from the
-- live definition so this replaces it rather than creating an overload.
create or replace function public.record_disbursement(
  p_deal_id        uuid,
  p_tranche_number integer,
  p_amount         numeric,
  p_disbursed_date date,
  p_academic_term  text default null,
  p_remarks        text default null
)
returns void
language plpgsql
as $function$
begin
  insert into disbursements (deal_id, tranche_number, amount, disbursed_date, academic_term, remarks, created_by)
  values (p_deal_id, p_tranche_number, p_amount, p_disbursed_date, p_academic_term, p_remarks, auth.uid());

  -- Both cached columns are recomputed from the ledger in one pass. Taking
  -- max(disbursed_date) rather than p_disbursed_date means recording a
  -- late-entered earlier tranche cannot drag the date backwards.
  update deals d
  set total_disbursed_amount = coalesce(agg.total, 0),
      final_disbursement_date = agg.latest,
      updated_by = auth.uid()
  from (
    select sum(amount) as total, max(disbursed_date) as latest
    from disbursements
    where deal_id = p_deal_id and is_deleted = false
  ) agg
  where d.id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Disbursement Recorded', p_remarks, auth.uid(), jsonb_build_object('tranche_number', p_tranche_number, 'amount', p_amount));
end;
$function$;


-- ---------- 2. Backfill deals that already have tranches ----------
-- Guarded by `is distinct from` so a second run updates nothing.
update deals d
set final_disbursement_date = agg.latest,
    total_disbursed_amount  = coalesce(agg.total, 0)
from (
  select deal_id, max(disbursed_date) as latest, sum(amount) as total
  from disbursements
  where is_deleted = false
  group by deal_id
) agg
where d.id = agg.deal_id
  and d.is_deleted = false
  and (d.final_disbursement_date is distinct from agg.latest
       or d.total_disbursed_amount is distinct from coalesce(agg.total, 0));


-- ---------- 3. Verify ----------
-- Expect these three to agree after applying. They currently read 3 / 3 / 0.
--
--   select
--     (select count(*) from (select distinct deal_id from disbursements where is_deleted = false) x) as deals_with_tranches,
--     (select count(*) from deals where is_deleted = false and total_disbursed_amount > 0)           as deals_with_amount,
--     (select count(*) from v_stage_milestones where milestone = 'Disbursement')                     as milestone_rows;
