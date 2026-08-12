-- Run this once on an EXISTING project that predates this file.
-- Depends on 052 (which defines the access pattern these reuse).
-- Every statement is CREATE OR REPLACE, so re-running is safe.
--
-- REPORTING FOR EXTERNAL PORTALS — lenders and consultants get their own
-- numbers and their own downloads, instead of asking an RM for them.
--
-- ---------------------------------------------------------------
-- WHY THIS COULD NOT REUSE v_stage_milestones
-- ---------------------------------------------------------------
-- The obvious move is to point the lender's report at v_stage_milestones
-- (migration 025), which already defines Login / Sanction / PF Paid /
-- Disbursement. It does not work: that view is security_invoker and its
-- base CTE does `join leads l on l.id = d.lead_id`. A lender has no SELECT
-- policy on `leads`, so the join eliminates every row and the view returns
-- empty for them — the same root cause as the blank student names fixed in
-- 052.
--
-- v_lender_milestones below is therefore the lender-side equivalent:
-- SECURITY DEFINER with `security_barrier = true` and an explicit
-- `is_lender_side() and belongs_to_lender_org(...)` predicate, exactly as
-- described in the 052 header. The milestone definitions are kept
-- character-for-character identical to v_stage_milestones so the two
-- cannot drift.
--
-- Disbursement is read from the `disbursements` ledger, not from
-- deals.final_disbursement_date, for the reason documented at length in
-- 050 and 051: nothing populates that column, so v_stage_milestones
-- reports zero disbursements. One row per tranche here; the RPCs collapse
-- with count(distinct deal_id).
-- =========================================================


-- =========================================================
-- v_lender_milestones — pipeline milestones for the caller's own bank.
--
-- SECURITY DEFINER + security_barrier. The WHERE clause is the access
-- control; do not remove or weaken it. See 036 header.
-- =========================================================
create or replace view v_lender_milestones
with (security_barrier = true) as
with base as (
  select d.id as deal_id, d.lead_id, d.lender_id,
         l.student_name, l.student_phone,
         lb.name as lender_branch,
         d.is_on_hold, d.is_rejected
  from deals d
  join leads l                 on l.id = d.lead_id and l.is_deleted = false
  left join lender_branches lb on lb.id = d.lender_branch_id
  where d.is_deleted = false
    -- ↓ THIS IS THE ACCESS CONTROL. Do not remove or weaken.
    and (select is_lender_side())
    and belongs_to_lender_org(d.lender_id)
)
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
select b.*, 'PF Paid'::text, 3, pf.pf_date, pf.pf_amount, null
from base b
join deal_pf_details pf on pf.deal_id = b.deal_id and pf.is_deleted = false
where pf.pf_date is not null

union all
select b.*, 'Disbursement'::text, 4, dd.disbursed_date, dd.amount,
       'Tranche ' || dd.tranche_number
from base b
join disbursements dd on dd.deal_id = b.deal_id and dd.is_deleted = false;

comment on view v_lender_milestones is
  'Login/Sanction/PF Paid/Disbursement for the caller''s own bank. SECURITY DEFINER + security_barrier by design — see 052 header. Mirrors v_stage_milestones, which returns nothing for lenders.';


-- =========================================================
-- lender_milestone_counts(from, to) — the lender's headline numbers.
--
-- Zero-filled: a milestone with nothing in the window comes back as 0
-- rather than vanishing, so a quiet month reads as "0" instead of the row
-- disappearing off the report.
-- =========================================================
create or replace function lender_milestone_counts(p_from date, p_to date)
returns table (
  milestone       text,
  milestone_order integer,
  deal_count      bigint,
  total_amount    numeric
)
language sql
stable
as $$
  select m.name, m.ord,
         coalesce(count(distinct v.deal_id), 0)::bigint,
         coalesce(sum(v.amount), 0)
  from (values ('Login', 1), ('Sanction', 2), ('PF Paid', 3), ('Disbursement', 4)) as m(name, ord)
  left join v_lender_milestones v
    on v.milestone = m.name
   and v.event_date >= p_from
   and v.event_date <= p_to
  group by m.name, m.ord
  order by m.ord
$$;

comment on function lender_milestone_counts(date, date) is
  'Zero-filled Login/Sanction/PF Paid/Disbursement counts + amounts for the caller''s bank in a date window.';


-- =========================================================
-- lender_milestone_series(from, to, bucket) — the same, per period, for
-- the daily / weekly / monthly matrix.
--
-- date_trunc('week', …) starts weeks on Monday, matching startOfWeek() in
-- the shared JS so the two bucket identically.
-- =========================================================
create or replace function lender_milestone_series(
  p_from   date,
  p_to     date,
  p_bucket text default 'month'
)
returns table (
  milestone       text,
  milestone_order integer,
  bucket_start    date,
  deal_count      bigint,
  total_amount    numeric
)
language plpgsql
stable
as $function$
begin
  if p_bucket not in ('day', 'week', 'month') then
    raise exception 'p_bucket must be one of day, week, month (got %)', p_bucket;
  end if;

  return query
  select v.milestone, v.milestone_order,
         date_trunc(p_bucket, v.event_date::timestamp)::date,
         count(distinct v.deal_id)::bigint,
         coalesce(sum(v.amount), 0)
  from v_lender_milestones v
  where v.event_date >= p_from and v.event_date <= p_to
  group by v.milestone, v.milestone_order, date_trunc(p_bucket, v.event_date::timestamp)
  order by v.milestone_order, 3;
end;
$function$;

comment on function lender_milestone_series(date, date, text) is
  'Per-bucket (day/week/month) milestone counts + amounts for the caller''s bank.';


-- =========================================================
-- source_performance(from, to) — the Consultant's (or BD's) own scorecard.
--
-- Scoped to leads the caller SOURCED (source_user_id = auth.uid()), which
-- is the same boundary the leads_select_source RLS policy already draws —
-- restated here explicitly because this function is SECURITY DEFINER and
-- therefore cannot inherit it.
--
-- SECURITY DEFINER is required for one reason: `deals` returns zero rows
-- to a source role, so "how many of my students actually got sanctioned"
-- is unanswerable from the portal today. Everything returned is an
-- AGGREGATE over the caller's own students — no other consultant's
-- numbers, no per-bank amounts, no internal remarks.
--
-- students_*   counted by lead creation date, in the window
-- milestone_*  counted on the milestone's own recorded date, in the window
-- =========================================================
create or replace function source_performance(p_from date default null, p_to date default null)
returns table (
  students_submitted   bigint,
  students_active      bigint,
  students_lost        bigint,
  shared_with_lender   bigint,
  logins               bigint,
  sanctions            bigint,
  sanctioned_amount    numeric,
  pf_paid              bigint,
  disbursed            bigint,
  disbursed_amount     numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;
  if not coalesce((select is_source_role()), false) then
    raise exception 'source_performance is for Consultant / Business Development accounts';
  end if;

  return query
  with mine as (
    select l.id, l.current_stage_id,
           (l.created_at at time zone 'Asia/Kolkata')::date as lead_date
    from leads l
    where l.source_user_id = v_uid and l.is_deleted = false
  ),
  windowed as (
    select * from mine
    where (p_from is null or lead_date >= p_from)
      and (p_to   is null or lead_date <= p_to)
  ),
  my_deals as (
    select d.id as deal_id, d.lead_id
    from deals d join mine m on m.id = d.lead_id
    where d.is_deleted = false
  )
  select
    (select count(*) from windowed)::bigint,
    (select count(*) from windowed w join lead_stages s on s.id = w.current_stage_id
      where s.is_terminal = false)::bigint,
    (select count(*) from windowed w join lead_stages s on s.id = w.current_stage_id
      where s.is_terminal = true)::bigint,
    (select count(distinct lead_id) from my_deals)::bigint,
    (select count(distinct dl.deal_id) from deal_login_details dl
      join my_deals md on md.deal_id = dl.deal_id
      where dl.is_deleted = false and dl.login_date is not null
        and (p_from is null or dl.login_date >= p_from)
        and (p_to   is null or dl.login_date <= p_to))::bigint,
    (select count(distinct sn.deal_id) from deal_sanction_details sn
      join my_deals md on md.deal_id = sn.deal_id
      where sn.is_deleted = false and sn.sanction_date is not null
        and (p_from is null or sn.sanction_date >= p_from)
        and (p_to   is null or sn.sanction_date <= p_to))::bigint,
    (select coalesce(sum(sn.sanction_amount), 0) from deal_sanction_details sn
      join my_deals md on md.deal_id = sn.deal_id
      where sn.is_deleted = false and sn.sanction_date is not null
        and (p_from is null or sn.sanction_date >= p_from)
        and (p_to   is null or sn.sanction_date <= p_to)),
    (select count(distinct pf.deal_id) from deal_pf_details pf
      join my_deals md on md.deal_id = pf.deal_id
      where pf.is_deleted = false and pf.pf_date is not null
        and (p_from is null or pf.pf_date >= p_from)
        and (p_to   is null or pf.pf_date <= p_to))::bigint,
    (select count(distinct dd.deal_id) from disbursements dd
      join my_deals md on md.deal_id = dd.deal_id
      where dd.is_deleted = false
        and (p_from is null or dd.disbursed_date >= p_from)
        and (p_to   is null or dd.disbursed_date <= p_to))::bigint,
    (select coalesce(sum(dd.amount), 0) from disbursements dd
      join my_deals md on md.deal_id = dd.deal_id
      where dd.is_deleted = false
        and (p_from is null or dd.disbursed_date >= p_from)
        and (p_to   is null or dd.disbursed_date <= p_to));
end;
$function$;

comment on function source_performance(date, date) is
  'Own scorecard for a Consultant / BD: students submitted, active, lost, plus lender-side milestones on their own students. SECURITY DEFINER, scoped to source_user_id = auth.uid().';


-- =========================================================
-- source_stage_breakdown(from, to) — the caller's own students per lead
-- stage, for the little bar chart on their report.
-- =========================================================
create or replace function source_stage_breakdown(p_from date default null, p_to date default null)
returns table (
  stage_name     text,
  sequence_order integer,
  student_count  bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;
  if not coalesce((select is_source_role()), false) then
    raise exception 'source_stage_breakdown is for Consultant / Business Development accounts';
  end if;

  return query
  select s.name, s.sequence_order, count(l.id)::bigint
  from lead_stages s
  left join leads l
    on l.current_stage_id = s.id
   and l.source_user_id = v_uid
   and l.is_deleted = false
   and (p_from is null or (l.created_at at time zone 'Asia/Kolkata')::date >= p_from)
   and (p_to   is null or (l.created_at at time zone 'Asia/Kolkata')::date <= p_to)
  where s.is_deleted = false
  group by s.name, s.sequence_order
  order by s.sequence_order;
end;
$function$;

comment on function source_stage_breakdown(date, date) is
  'Own students per lead stage for a Consultant / BD. Zero-filled across all stages. SECURITY DEFINER, scoped to source_user_id = auth.uid().';
