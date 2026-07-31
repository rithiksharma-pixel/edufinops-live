-- Run once on an EXISTING project. ALREADY APPLIED (migration 032_deal_tat_breach).
-- NOTE: the digest half of this work is in 033 — see the header there for why.
--
-- Item 4: "If a lead breaches the assigned/avg TAT, then this should show
-- that the lead has breached the TAT of this, also this should be included
-- in the digest and summaries of the RM/Manager/Admins"
--
-- v_deal_tat gives days-in-current-stage plus a breach flag per LIVE deal.
-- The thresholds were already hardcoded identically in three client files
-- (admin, manager analytics, rm dashboard); putting them in the database
-- makes it the single source, so a digest and a screen can never disagree
-- about whether something has breached.
--
-- The clock starts when the deal ENTERED its current stage — the newest
-- deal_event whose to_stage_id is that stage — not deals.updated_at, which
-- also bumps on a hold or a remark and would silently reset the breach
-- every time someone touched the deal.
--
-- Terminal stages and rejected/on-hold deals are excluded: a finished or
-- paused deal cannot breach a turnaround time.

create or replace view v_deal_tat
with (security_invoker = on) as
select
  d.id as deal_id, d.lead_id, l.student_name, l.assigned_rm_id,
  u.full_name as assigned_rm, ln.name as lender, ds.name as stage,
  ent.entered_at,
  (current_date - ent.entered_at::date) as days_in_stage,
  thr.threshold_days,
  (current_date - ent.entered_at::date) > thr.threshold_days as is_breached,
  (current_date - ent.entered_at::date) - thr.threshold_days as days_over
from deals d
join leads l         on l.id = d.lead_id and l.is_deleted = false
join deal_stages ds  on ds.id = d.current_deal_stage_id
left join users u    on u.id = l.assigned_rm_id
left join lenders ln on ln.id = d.lender_id
left join lateral (
  select coalesce(max(de.created_at), d.created_at) as entered_at
  from deal_events de
  where de.deal_id = d.id and de.to_stage_id = d.current_deal_stage_id
) ent on true
join lateral (
  select case ds.name
    when 'Bank Prospect' then 7
    when 'Login'         then 5
    when 'Sanction'      then 10
    when 'PF Paid'       then 5
    when 'Disbursement'  then 7
    else null end as threshold_days
) thr on thr.threshold_days is not null
where d.is_deleted = false and d.is_rejected = false
  and d.is_on_hold = false and ds.is_terminal = false;

comment on view v_deal_tat is
  'Days a live deal has sat in its current stage, with the per-stage TAT threshold and a breach flag. security_invoker: RLS-scoped to the caller.';
