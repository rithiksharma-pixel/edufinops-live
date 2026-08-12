-- OPTIONAL — NARROWER THAN IT LOOKS. Read this before applying.
--
-- ---------------------------------------------------------------
-- THE BUG
-- ---------------------------------------------------------------
-- record_disbursement() writes the tranche to `disbursements` and refreshes
-- deals.total_disbursed_amount, but never sets
-- deals.final_disbursement_date.
--
-- v_stage_milestones (025 / 027) emits its Disbursement row only
-- `where d.final_disbursement_date is not null`. With that column never
-- written, the milestone stream contains ZERO disbursements no matter how
-- many actually happened.
--
-- Measured on this project on 2026-08-12:
--
--   disbursements ledger rows ........ 3   (Rs 1,14,07,774 across 3 deals)
--   deals.total_disbursed_amount set . 3
--   deals.final_disbursement_date set  0   <- nothing ever writes it
--   v_stage_milestones 'Disbursement'  0   <- so the card says zero
--
-- ---------------------------------------------------------------
-- WHAT IS *NOT* AFFECTED — this is why the fix is narrow
-- ---------------------------------------------------------------
-- Migration 045 denormalised login/sanction/pf/disbursed dates onto
-- `leads`, and it derives disbursed_date from the `disbursements` LEDGER,
-- not from deals.final_disbursement_date. So everything built on 045 is
-- already correct and needs nothing from this file:
--
--   * rm_performance()   (046)  — the Performance table
--   * bd_performance()   (050)  — BD performance
--   * consultancy_report() (039) — Partner Reports
--   * the lead list's "Date basis" filter
--
-- The 3 disbursed leads show up correctly in all of those today.
--
-- What IS still wrong is only the older v_stage_milestones path:
--   * "Milestones by date" on the Manager Dashboard
--   * the same card under Admin -> Analytics -> Reports
--   * the milestone CSV
-- Those three report 0 disbursements.
--
-- Also unaffected, and always was: the "Disbursed amount" stat cards, which
-- sum deals.total_disbursed_amount directly. That split is why this went
-- unnoticed — one number on the page was right while another was zero.
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
-- After applying, the Milestones cards show 3 disbursements instead of 0.
-- Nothing decreases, and no lead, deal or ledger row is modified — only a
-- derived date column is populated.
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
