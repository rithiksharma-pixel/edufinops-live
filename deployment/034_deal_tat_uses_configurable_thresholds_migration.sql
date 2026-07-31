-- Run once on an EXISTING project. ALREADY APPLIED (034_deal_tat_uses_configurable_thresholds).
--
-- v_deal_tat hardcoded its TAT thresholds in a CASE. In parallel work,
-- stage_tat_thresholds was added as an admin-editable table and the
-- dashboards were moved onto it. The two agreed by coincidence, so nothing
-- looked wrong — but editing a threshold in Admin Settings would have moved
-- the dashboards and left the lead summary and all three digests on the old
-- number, with no error anywhere. Two sources of truth for one rule is
-- exactly what v_deal_tat existed to remove.
--
-- Now joined to the table. INNER join on purpose: a stage with no configured
-- row drops out of the view entirely, matching getTatThresholds()'s
-- documented contract that a missing key means "don't flag this stage"
-- rather than silently defaulting it.
--
-- Verified after applying: raising Bank Prospect's threshold changed the
-- breach count, and restoring it returned the count to 49.
create or replace view v_deal_tat
with (security_invoker = on) as
select
  d.id as deal_id, d.lead_id, l.student_name, l.assigned_rm_id,
  u.full_name as assigned_rm, ln.name as lender, ds.name as stage,
  ent.entered_at,
  (current_date - ent.entered_at::date) as days_in_stage,
  t.threshold_days,
  (current_date - ent.entered_at::date) > t.threshold_days as is_breached,
  (current_date - ent.entered_at::date) - t.threshold_days as days_over
from deals d
join leads l         on l.id = d.lead_id and l.is_deleted = false
join deal_stages ds  on ds.id = d.current_deal_stage_id
join stage_tat_thresholds t on t.deal_stage_id = ds.id and t.threshold_days is not null
left join users u    on u.id = l.assigned_rm_id
left join lenders ln on ln.id = d.lender_id
left join lateral (
  select coalesce(max(de.created_at), d.created_at) as entered_at
  from deal_events de
  where de.deal_id = d.id and de.to_stage_id = d.current_deal_stage_id
) ent on true
where d.is_deleted = false and d.is_rejected = false
  and d.is_on_hold = false and ds.is_terminal = false;

comment on view v_deal_tat is
  'Days a live deal has sat in its current stage, with its admin-configured TAT threshold (stage_tat_thresholds) and a breach flag. security_invoker: RLS-scoped to the caller.';
