-- =========================================================
-- 050 — BD performance
--
-- "How is each Business Development person doing?" — channels, leads,
-- logins, sanctions, PF, disbursed and disbursed value, over any window.
--
-- Deliberately a SIBLING of rm_performance() (046) rather than a parallel
-- reporting stack: same return shape, same column names, same
-- each-metric-against-its-own-date rule, same null-bounds-mean-all-time
-- convention. It slots into the existing Performance table on the Manager
-- Dashboard as a fourth grouping, so Day/Week/Month/Overall, the CSV and
-- the layout all come for free and a BD row is directly comparable with an
-- owner/team/manager row.
--
-- Reads the denormalised milestone dates that 045 put on `leads`
-- (login_date, sanction_date, pf_date, disbursed_date) for the same reason
-- rm_performance does: one flat indexed filter instead of a four-way join
-- through the per-deal detail tables. It also means disbursements are
-- counted correctly — 045 derives disbursed_date from the `disbursements`
-- ledger, not from deals.final_disbursement_date, which nothing populates.
--
-- ---------------------------------------------------------------
-- WHY THE GROUP KEY IS TEXT, NOT A uuid
-- ---------------------------------------------------------------
-- rm_performance returns group_id uuid because an owner/team/manager is a
-- real record. A BD person is not: attribution lives in two free-text
-- columns, consultancies.bd_manager (012) and leads.bd_name (026). There
-- is no users FK to return.
--
-- This does not convert them to one. A backfill would have to guess which
-- `users` row each historical name meant, and a wrong guess silently moves
-- someone else's numbers. bd_key() folds the harmless half of the problem
-- (case, stray whitespace); real typos stay visible as near-duplicate
-- rows, which is the prompt to fix the underlying record.
--
-- Per-lead bd_name wins over the consultancy's bd_manager where both
-- exist — 026 stores it precisely because the person who brought in a
-- given student can differ from the account owner — and falls back to the
-- consultancy otherwise. On this project only 291 of 12,185 leads carry a
-- bd_name while 5,532 have a consultancy, so the fallback is the
-- difference between covering ~2% of the pipeline and ~45%.
--
-- ---------------------------------------------------------------
-- CHANNELS
-- ---------------------------------------------------------------
-- channels        every consultancy this BD owns. A roster, so it is
--                 deliberately NOT filtered by the date window.
-- active_channels those that produced a lead inside the window.
--
-- SECURITY INVOKER (the default), like rm_performance and
-- consultancy_report: RLS decides what the caller sees, and there is no
-- role logic here.
-- =========================================================


-- =========================================================
-- Clear the earlier, superseded version of this feature FIRST.
--
-- That version predated 045 and built its own Login/Sanction/PF/
-- Disbursement milestone stream out of the per-deal detail tables. It is
-- redundant now that those dates sit on `leads`, and leaving it would mean
-- two definitions of the same numbers, free to drift.
--
-- These run before the creates, not after, because v_bd_leads is being
-- redefined with different columns and CREATE OR REPLACE VIEW cannot
-- rename or drop a column — it fails with "cannot change name of view
-- column". CASCADE takes the dependent views with it, which is what we
-- want since they are on this list anyway.
--
-- Safe on a project that never had the earlier version: every statement
-- is IF EXISTS.
-- =========================================================
drop function if exists public.bd_performance_series(date, date, text);
-- Also dropped: it selected r.bd_name / r.pf_paid from bd_performance(),
-- columns this revision renames to group_name / pf, so it could only error.
-- Email has never actually sent on this project anyway (NOTIFICATION_SECRET
-- is unset — see DEPLOYMENT.md), and the CSV covers the manual case. Re-add
-- it when notifications work, against the current column names.
drop function if exists public.send_bd_performance_report(date, date, text);
drop view     if exists public.v_bd_activity   cascade;
drop view     if exists public.v_bd_milestones cascade;
drop view     if exists public.v_bd_channels   cascade;
drop view     if exists public.v_bd_leads      cascade;


-- =========================================================
-- bd_key() — canonical grouping key for a free-text BD name.
-- =========================================================
create or replace function public.bd_key(p_name text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '')
$$;

comment on function public.bd_key(text) is
  'Canonical grouping key for a free-text BD name: trimmed, whitespace-collapsed, lowercased. NULL for blank.';


-- =========================================================
-- v_bd_leads — one row per lead with BD attribution resolved, plus the
-- milestone dates 045 denormalised. Backs both the RPC and the detail CSV,
-- so the export and the on-screen totals count the same rows.
-- =========================================================
create or replace view public.v_bd_leads
with (security_invoker = on) as
select
  l.id                                   as lead_id,
  bd.bd_name,
  public.bd_key(bd.bd_name)              as bd_key,
  -- Which column the attribution came from, so a data-quality pass can
  -- tell "no BD recorded" from "inherited from the consultancy".
  case
    when nullif(btrim(l.bd_name), '') is not null    then 'lead'
    when nullif(btrim(c.bd_manager), '') is not null then 'consultancy'
    else 'unattributed'
  end                                    as bd_source,
  c.id                                   as consultancy_id,
  coalesce(c.name, nullif(btrim(l.consultancy_other_name), '')) as consultancy,
  src.name                               as lead_source,
  ls.name                                as lead_stage,
  rm.full_name                           as assigned_rm,
  l.student_name, l.student_phone, l.loan_amount_requested,
  l.created_at, l.next_follow_up_at,
  l.login_date, l.sanction_date, l.pf_date, l.disbursed_date,
  -- Rows this report is about at all. A lead with no BD name but a
  -- consultancy still belongs: it is BD business whose owner was never
  -- recorded, and hiding it would make the report disagree with the
  -- pipeline. It lands in the '(Unattributed)' row.
  (
    public.bd_key(bd.bd_name) is not null
    or c.id is not null
    or nullif(btrim(l.consultancy_other_name), '') is not null
    or src.category = 'Business Development'
  )                                      as is_bd_scope
from public.leads l
left join public.consultancies c  on c.id = l.consultancy_id and not c.is_deleted
left join public.lead_sources src on src.id = l.lead_source_id
left join public.lead_stages ls   on ls.id = l.current_stage_id
left join public.users rm         on rm.id = l.assigned_rm_id
cross join lateral (
  select coalesce(nullif(btrim(l.bd_name), ''), nullif(btrim(c.bd_manager), '')) as bd_name
) bd
where not l.is_deleted;

comment on view public.v_bd_leads is
  'One row per lead with BD attribution resolved (lead.bd_name, else consultancy.bd_manager) plus the 045 milestone dates. security_invoker.';


-- =========================================================
-- bd_performance(from, to) — the leaderboard.
--
-- Column order and names mirror rm_performance() so the same table
-- component renders either, with channels/active_channels appended.
-- =========================================================
drop function if exists public.bd_performance(date, date);

create or replace function public.bd_performance(
  p_from date default null,
  p_to   date default null
)
returns table (
  group_key         text,
  group_name        text,
  channels          bigint,
  active_channels   bigint,
  leads             bigint,
  overdue           bigint,
  logins            bigint,
  sanctions         bigint,
  pf                bigint,
  disbursed         bigint,
  disbursed_amount  numeric
)
language sql
stable
set search_path to 'public'
as $function$
  with scoped as (
    select v.*,
           coalesce(dd.amt, 0) as disbursed_amt
    from v_bd_leads v
    left join lateral (
      select coalesce(sum(d.total_disbursed_amount), 0) as amt
      from deals d where d.lead_id = v.lead_id and not d.is_deleted
    ) dd on true
    where v.is_bd_scope
  ),
  agg as (
    select
      s.bd_key,
      -- mode() picks the most common original spelling rather than an
      -- arbitrary one, so the display name is stable across runs.
      mode() within group (order by s.bd_name) as bd_name,
      count(*) filter (where (p_from is null or s.created_at::date >= p_from)
                         and (p_to   is null or s.created_at::date <= p_to))::bigint as leads,
      -- Right-now measure, deliberately ignoring the window — same as
      -- rm_performance's `overdue`.
      count(*) filter (where s.next_follow_up_at < now())::bigint as overdue,
      count(*) filter (where s.login_date is not null
                         and (p_from is null or s.login_date >= p_from)
                         and (p_to   is null or s.login_date <= p_to))::bigint as logins,
      count(*) filter (where s.sanction_date is not null
                         and (p_from is null or s.sanction_date >= p_from)
                         and (p_to   is null or s.sanction_date <= p_to))::bigint as sanctions,
      count(*) filter (where s.pf_date is not null
                         and (p_from is null or s.pf_date >= p_from)
                         and (p_to   is null or s.pf_date <= p_to))::bigint as pf,
      count(*) filter (where s.disbursed_date is not null
                         and (p_from is null or s.disbursed_date >= p_from)
                         and (p_to   is null or s.disbursed_date <= p_to))::bigint as disbursed,
      coalesce(sum(s.disbursed_amt) filter (where s.disbursed_date is not null
                         and (p_from is null or s.disbursed_date >= p_from)
                         and (p_to   is null or s.disbursed_date <= p_to)), 0) as disbursed_amount,
      count(distinct s.consultancy_id) filter (where s.consultancy_id is not null
                         and (p_from is null or s.created_at::date >= p_from)
                         and (p_to   is null or s.created_at::date <= p_to))::bigint as active_channels
    from scoped s
    group by s.bd_key
  ),
  -- The roster, independent of the window.
  ch as (
    select bd_key(c.bd_manager) as bd_key,
           mode() within group (order by nullif(btrim(c.bd_manager), '')) as bd_name,
           count(*)::bigint as channels
    from consultancies c
    where not c.is_deleted and bd_key(c.bd_manager) is not null
    group by 1
  ),
  -- Every key from either side, so a BD who owns channels but produced
  -- nothing in the period still gets a row of zeros, and one with activity
  -- but no channel record does too — a disappearing row reads as "no data"
  -- when the answer is "nothing happened".
  --
  -- A UNION plus LEFT JOINs rather than the FULL OUTER JOIN this obviously
  -- wants: the join key can be NULL (the '(Unattributed)' bucket), which
  -- needs `is not distinct from`, and Postgres rejects that on a FULL JOIN
  -- with "FULL JOIN is only supported with merge-joinable or hash-joinable
  -- join conditions". LEFT JOIN has no such restriction.
  universe as (
    select agg.bd_key from agg
    union
    select ch.bd_key from ch
  )
  select
    u.bd_key,
    coalesce(agg.bd_name, ch.bd_name),
    coalesce(ch.channels, 0),
    coalesce(agg.active_channels, 0),
    coalesce(agg.leads, 0),
    coalesce(agg.overdue, 0),
    coalesce(agg.logins, 0),
    coalesce(agg.sanctions, 0),
    coalesce(agg.pf, 0),
    coalesce(agg.disbursed, 0),
    coalesce(agg.disbursed_amount, 0)
  from universe u
  left join agg on agg.bd_key is not distinct from u.bd_key
  left join ch  on ch.bd_key  is not distinct from u.bd_key
  order by 5 desc, 2;
$function$;

comment on function public.bd_performance(date, date) is
  'Per-BD leaderboard for a date window (NULL bounds = all time). Mirrors rm_performance() with channels/active_channels added. security_invoker.';
