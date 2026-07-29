-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 025_stage_milestones_view).
-- Every statement is CREATE OR REPLACE, so re-running is safe.
--
-- "How many logins between X and Y?" — and the same for Sanction, PF and
-- Disbursement. Those dates are NOT columns on `deals`; each stage keeps
-- its own detail table, so answering that question previously meant a
-- four-way join nobody was going to write by hand.
--
-- v_stage_milestones flattens all four into one row per dated milestone,
-- turning the question into a plain date filter. milestone_counts() wraps
-- it as an RPC the dashboard calls directly.
--
-- Both run with security_invoker, so RLS applies to the CALLER: an RM's
-- numbers cover their own deals, a Manager's their team, an Admin's
-- everything — with no role logic in the client. Verified on live data:
-- Admin 43 logins, Manager 16, RM 10 for the same window.

create or replace view v_stage_milestones
with (security_invoker = on) as
with base as (
  select d.id as deal_id, d.lead_id, l.student_name, l.student_phone,
         ln.name as lender, lb.name as lender_branch,
         rm.full_name as assigned_rm, tm.name as team,
         src.name as lead_source,
         d.is_on_hold, d.is_rejected
  from deals d
  join leads l                 on l.id = d.lead_id and l.is_deleted = false
  left join lenders ln         on ln.id = d.lender_id
  left join lender_branches lb on lb.id = d.lender_branch_id
  left join users rm           on rm.id = l.assigned_rm_id
  left join teams tm           on tm.id = rm.team_id
  left join lead_sources src   on src.id = l.lead_source_id
  where d.is_deleted = false
)
-- Only stages with a date recorded contribute a row. A deal parked at PF
-- with no pf_date produces no PF row on purpose — counting it would
-- overstate throughput.
select b.*, 'Login'::text as milestone, 1 as milestone_order,
       dl.login_date as event_date, dl.login_amount as amount, dl.login_id as reference
from base b
join deal_login_details dl on dl.deal_id = b.deal_id and dl.is_deleted = false
where dl.login_date is not null

union all
select b.*, 'Sanction'::text, 2, sn.sanction_date, sn.sanction_amount, null
from base b
join deal_sanction_details sn on sn.deal_id = b.deal_id and sn.is_deleted = false
where sn.sanction_date is not null

union all
select b.*, 'PF'::text, 3, pf.pf_date, pf.pf_amount, null
from base b
join deal_pf_details pf on pf.deal_id = b.deal_id and pf.is_deleted = false
where pf.pf_date is not null

union all
select b.*, 'Disbursement'::text, 4, d.final_disbursement_date, d.total_disbursed_amount, null
from base b
join deals d on d.id = b.deal_id
where d.final_disbursement_date is not null;

comment on view v_stage_milestones is
  'One row per dated pipeline milestone (Login/Sanction/PF/Disbursement). Powers date-range counts. security_invoker: RLS-scoped to the caller.';

create or replace function milestone_counts(p_from date, p_to date)
returns table (milestone text, milestone_order int, deal_count bigint, total_amount numeric)
language sql
stable
security invoker   -- deliberately NOT security definer: must not bypass RLS
set search_path to 'public'
as $$
  select m.milestone, m.milestone_order, count(*)::bigint, coalesce(sum(m.amount), 0)
  from v_stage_milestones m
  where m.event_date >= p_from and m.event_date <= p_to
  group by m.milestone, m.milestone_order
  order by m.milestone_order
$$;
