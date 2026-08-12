-- Run this once on an EXISTING project that predates this file.
-- Every statement is CREATE OR REPLACE, so re-running is safe.
--
-- BD PERFORMANCE — "how is each Business Development person doing?"
--   channels · leads · logins · sanctions · PF paid · disbursed (+ amount)
--   sliced daily / weekly / monthly / overall.
--
-- ---------------------------------------------------------------
-- HOW A BD PERSON IS IDENTIFIED (and why it is still free text)
-- ---------------------------------------------------------------
-- There is no BD foreign key on leads. Attribution lives in two free-text
-- columns, added by migrations 012 and 026:
--
--   consultancies.bd_manager  who owns the CHANNEL (the partner relationship)
--   leads.bd_name             who sourced THIS student (may differ, and is
--                             only populated on leads created after 026)
--
-- This migration deliberately does NOT convert those to user FKs. Doing so
-- needs a backfill that guesses which `users` row each historical name meant,
-- and a wrong guess silently reassigns someone else's numbers. Free text is
-- reported on as-is, so the report can never invent attribution that the data
-- does not actually contain.
--
-- The cost of that choice: two spellings of the same person are two people.
-- bd_key() absorbs the harmless half of that (case and stray whitespace);
-- real typos stay visible, which is the honest outcome — they show up as a
-- near-duplicate row in the report, which is exactly the prompt to fix the
-- underlying record. The '(Unattributed)' row exists for the same reason.
--
-- Per-lead bd_name wins over the consultancy's bd_manager when both are
-- present: 026 stores it precisely because the person who brought in a given
-- student can differ from the account owner, and it is captured at the moment
-- the lead is created rather than re-derived later.
--
-- ---------------------------------------------------------------
-- SECURITY
-- ---------------------------------------------------------------
-- Every view and function here is security_invoker / SECURITY INVOKER, the
-- same choice v_master_data and v_stage_milestones made: they run as the
-- CALLER, so leads/deals RLS decides what each role sees. A Manager's BD
-- numbers cover their team, an Admin's cover the org, and no role logic is
-- needed in the client. The one exception is send_bd_performance_report()
-- at the bottom, which is SECURITY DEFINER because cron has no JWT — see
-- the note there.
--
-- ---------------------------------------------------------------
-- CONSISTENCY WITH THE EXISTING MILESTONE REPORT
-- ---------------------------------------------------------------
-- Login / Sanction / PF Paid are read from v_stage_milestones (migration
-- 025, redefined by 027) rather than re-derived from the stage detail
-- tables. A BD report whose "logins" disagreed with the Milestones card on
-- the same dashboard would be a support ticket, so there is exactly one
-- definition of those and this file joins BD attribution onto it.
--
-- ⚠ DISBURSEMENT IS THE EXCEPTION, AND DELIBERATELY SO.
--
-- v_stage_milestones emits a Disbursement row only `where
-- d.final_disbursement_date is not null` — but record_disbursement()
-- updates deals.total_disbursed_amount and NEVER sets
-- final_disbursement_date. On this project that leaves 3 disbursed deals
-- worth ₹1.14 crore with a NULL date, so v_stage_milestones reports ZERO
-- disbursements and so does every card built on it.
--
-- This file therefore reads disbursements from the `disbursements` ledger,
-- which the master migration already names as the source of truth (the
-- deals columns are described there as "a fast-read cache … not the ledger
-- itself"). The v_stage_milestones 'Disbursement' rows are excluded from
-- v_bd_milestones so the two can never double-count once the underlying
-- bug is fixed.
--
-- The bug itself is NOT fixed here — patching record_disbursement() would
-- change numbers on dashboards outside this feature's scope. See
-- 035_disbursement_date_backfill_migration.sql, which is optional and
-- separate for exactly that reason.
--
-- A consequence worth knowing: until 035 is applied, this report's
-- "Disbursed" column and the Milestones card's "Disbursement" row will
-- disagree — this one is right.
-- =========================================================


-- =========================================================
-- bd_key() — canonical grouping key for a BD name.
--
-- Case and whitespace differences ('ravi kumar', 'Ravi  Kumar ') are the
-- same person and are folded together. Anything beyond that is left alone
-- on purpose; see the note above.
-- =========================================================
create or replace function bd_key(p_name text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '')
$$;

comment on function bd_key(text) is
  'Canonical grouping key for a free-text BD name: trimmed, whitespace-collapsed, lowercased. NULL for blank.';


-- =========================================================
-- v_bd_channels — one row per consultancy (a "channel"), with the BD
-- person who owns the relationship.
--
-- A channel is counted for a BD person whether or not it has produced a
-- lead: it is the roster of relationships they hold. "Did it actually
-- produce anything in this period" is the separate active_channels figure
-- in bd_performance() below.
-- =========================================================
create or replace view v_bd_channels
with (security_invoker = on) as
select
  c.id                             as consultancy_id,
  c.name                           as consultancy,
  nullif(btrim(c.bd_manager), '')  as bd_name,
  bd_key(c.bd_manager)             as bd_key,
  c.is_active,
  c.created_at
from consultancies c
where c.is_deleted = false;

comment on view v_bd_channels is
  'One row per consultancy (BD channel) with its owning BD person. security_invoker.';


-- =========================================================
-- v_bd_leads — one row per lead, with BD attribution resolved.
--
-- lead_date is deliberately the IST calendar date, not the UTC one.
-- leads.created_at is timestamptz and Supabase sessions run in UTC, so
-- date_trunc on it would push everything created after 18:30 IST into the
-- next day. The milestone dates this report sits alongside (login_date,
-- sanction_date, …) are plain `date` columns already recorded in local
-- terms, so converting here is what makes the two agree.
-- =========================================================
create or replace view v_bd_leads
with (security_invoker = on) as
select
  l.id                                   as lead_id,
  bd.bd_name,
  bd_key(bd.bd_name)                     as bd_key,
  -- Which column the attribution came from. Surfaced so a data-quality
  -- pass can tell "no BD recorded" from "inherited from the consultancy".
  case
    when nullif(btrim(l.bd_name), '') is not null    then 'lead'
    when nullif(btrim(c.bd_manager), '') is not null then 'consultancy'
    else 'unattributed'
  end                                    as bd_source,
  c.id                                   as consultancy_id,
  coalesce(c.name, nullif(btrim(l.consultancy_other_name), '')) as consultancy,
  src.name                               as lead_source,
  src.category                           as lead_source_category,
  ls.name                                as lead_stage,
  rm.full_name                           as assigned_rm,
  l.student_name,
  l.student_phone,
  l.loan_amount_requested,
  (l.created_at at time zone 'Asia/Kolkata')::date as lead_date,
  -- Rows this report is about at all. A lead with no BD name but a
  -- consultancy still belongs here: it is BD business whose owner was
  -- never recorded, and hiding it would make the report disagree with the
  -- pipeline. It lands in the '(Unattributed)' row.
  (
    bd_key(bd.bd_name) is not null
    or c.id is not null
    or nullif(btrim(l.consultancy_other_name), '') is not null
    or src.category = 'Business Development'
  )                                      as is_bd_scope
from leads l
left join consultancies c   on c.id = l.consultancy_id and c.is_deleted = false
left join lead_sources src  on src.id = l.lead_source_id
left join lead_stages ls    on ls.id = l.current_stage_id
left join users rm          on rm.id = l.assigned_rm_id
cross join lateral (
  select coalesce(nullif(btrim(l.bd_name), ''), nullif(btrim(c.bd_manager), '')) as bd_name
) bd
where l.is_deleted = false;

comment on view v_bd_leads is
  'One row per lead with BD attribution resolved (lead.bd_name, else consultancy.bd_manager). security_invoker.';


-- =========================================================
-- v_bd_milestones — every pipeline milestone with BD attribution attached.
--
-- Login / Sanction / PF Paid come from v_stage_milestones, so those three
-- keep one shared definition with the Milestones card.
--
-- Disbursement comes from the `disbursements` ledger instead, because
-- v_stage_milestones' own Disbursement rows key off a column nothing
-- populates — see the header note. One row per TRANCHE here (that is what
-- the ledger holds); bd_performance() collapses them with
-- count(distinct deal_id) so "disbursed" means cases, not instalments,
-- while the amount still sums every tranche in the window.
-- =========================================================
create or replace view v_bd_milestones
with (security_invoker = on) as
select
  m.deal_id, m.lead_id, m.student_name, m.student_phone,
  m.lender, m.lender_branch, m.assigned_rm, m.team, m.lead_source,
  m.is_on_hold, m.is_rejected,
  m.milestone, m.milestone_order, m.event_date, m.amount, m.reference,
  b.bd_name, b.bd_key, b.bd_source, b.consultancy, b.consultancy_id, b.is_bd_scope
from v_stage_milestones m
join v_bd_leads b on b.lead_id = m.lead_id
-- Excluded rather than trusted: re-added below from the ledger. Keeping
-- both would double-count the moment final_disbursement_date starts
-- getting written.
where m.milestone <> 'Disbursement'

union all

select
  d.id, d.lead_id, b.student_name, b.student_phone,
  ln.name, lb.name, b.assigned_rm, tm.name, b.lead_source,
  d.is_on_hold, d.is_rejected,
  'Disbursement'::text, 4, dd.disbursed_date, dd.amount,
  'Tranche ' || dd.tranche_number,
  b.bd_name, b.bd_key, b.bd_source, b.consultancy, b.consultancy_id, b.is_bd_scope
from disbursements dd
join deals d                 on d.id = dd.deal_id and d.is_deleted = false
join v_bd_leads b            on b.lead_id = d.lead_id
left join lenders ln         on ln.id = d.lender_id
left join lender_branches lb on lb.id = d.lender_branch_id
left join leads l            on l.id = d.lead_id
left join users rm           on rm.id = l.assigned_rm_id
left join teams tm           on tm.id = rm.team_id
where dd.is_deleted = false;

comment on view v_bd_milestones is
  'Pipeline milestones with BD attribution. Login/Sanction/PF Paid from v_stage_milestones; Disbursement from the disbursements ledger (one row per tranche). security_invoker.';


-- =========================================================
-- v_bd_activity — the row-level ledger behind every number in the report.
--
-- One row per lead created, plus one per milestone hit. This is what the
-- detail CSV exports, so the export and the on-screen totals are the same
-- rows counted the same way.
-- =========================================================
create or replace view v_bd_activity
with (security_invoker = on) as
select
  b.bd_key, b.bd_name, b.bd_source, b.consultancy,
  'Lead'::text            as activity,
  b.lead_date             as activity_date,
  b.loan_amount_requested as amount,
  b.student_name, b.student_phone,
  b.lead_source, b.assigned_rm,
  null::text              as lender,
  null::text              as lender_branch,
  b.lead_id,
  null::uuid              as deal_id
from v_bd_leads b
where b.is_bd_scope

union all

select
  m.bd_key, m.bd_name, m.bd_source, m.consultancy,
  m.milestone,
  m.event_date,
  m.amount,
  m.student_name, m.student_phone,
  m.lead_source, m.assigned_rm,
  m.lender,
  m.lender_branch,
  m.lead_id,
  m.deal_id
from v_bd_milestones m
where m.is_bd_scope;

comment on view v_bd_activity is
  'Row-level BD ledger: one row per lead created and per milestone hit. Backs the detail CSV. security_invoker.';


-- =========================================================
-- bd_performance(from, to) — the leaderboard.
--
-- Pass NULL for both bounds to get all-time ("Overall").
--
-- channels        every consultancy this BD owns, period-independent —
--                 it is a roster, not throughput
-- active_channels those that produced at least one lead inside the window
--
-- Leads are counted by creation date; milestones by their own recorded
-- date. A BD with channels but no activity in the window still appears,
-- with zeros — a disappearing row reads as "no data" when the real answer
-- is "nothing happened", which is the thing a manager needs to see.
-- =========================================================
create or replace function bd_performance(p_from date default null, p_to date default null)
returns table (
  bd_key           text,
  bd_name          text,
  channels         bigint,
  active_channels  bigint,
  leads            bigint,
  lead_amount      numeric,
  logins           bigint,
  login_amount     numeric,
  sanctions        bigint,
  sanction_amount  numeric,
  pf_paid          bigint,
  pf_amount        numeric,
  disbursed        bigint,
  disbursed_amount numeric
)
language sql
stable
security invoker   -- deliberately NOT security definer: must not bypass RLS
set search_path to 'public'
as $$
  with ld as (
    select v.bd_key, v.bd_name, v.consultancy_id, v.loan_amount_requested
    from v_bd_leads v
    where v.is_bd_scope
      and (p_from is null or v.lead_date >= p_from)
      and (p_to   is null or v.lead_date <= p_to)
  ),
  ms as (
    select v.bd_key, v.bd_name, v.milestone, v.amount, v.deal_id
    from v_bd_milestones v
    where v.is_bd_scope
      and (p_from is null or v.event_date >= p_from)
      and (p_to   is null or v.event_date <= p_to)
  ),
  ch as (
    select v.bd_key, v.bd_name, v.consultancy_id
    from v_bd_channels v
    where v.bd_key is not null
  ),
  -- Every BD key that appears anywhere, so a BD with channels but no
  -- activity (or activity but no channel record) still gets a row.
  universe as (
    select ld.bd_key from ld
    union
    select ms.bd_key from ms
    union
    select ch.bd_key from ch
  ),
  -- One display spelling per key. mode() picks the most common original
  -- casing rather than an arbitrary one.
  names as (
    select n.bd_key, mode() within group (order by n.bd_name) as bd_name
    from (
      select ld.bd_key, ld.bd_name from ld where ld.bd_name is not null
      union all
      select ms.bd_key, ms.bd_name from ms where ms.bd_name is not null
      union all
      select ch.bd_key, ch.bd_name from ch where ch.bd_name is not null
    ) n
    group by n.bd_key
  ),
  ld_agg as (
    select ld.bd_key,
           count(*)::bigint                             as leads,
           coalesce(sum(ld.loan_amount_requested), 0)   as lead_amount
    from ld group by ld.bd_key
  ),
  -- count(distinct deal_id), not count(*): Disbursement carries one row
  -- per tranche, so a two-instalment case must still count as one
  -- disbursed deal. The other three are already one row per deal (deal_id
  -- is the PK of each stage detail table), so this is a no-op for them —
  -- written uniformly so the columns stay comparable.
  ms_agg as (
    select ms.bd_key,
           count(distinct ms.deal_id) filter (where ms.milestone = 'Login')::bigint     as logins,
           coalesce(sum(ms.amount) filter (where ms.milestone = 'Login'), 0)            as login_amount,
           count(distinct ms.deal_id) filter (where ms.milestone = 'Sanction')::bigint  as sanctions,
           coalesce(sum(ms.amount) filter (where ms.milestone = 'Sanction'), 0)         as sanction_amount,
           -- 'PF Paid' since migration 027 renamed the stage from 'PF'.
           count(distinct ms.deal_id) filter (where ms.milestone = 'PF Paid')::bigint   as pf_paid,
           coalesce(sum(ms.amount) filter (where ms.milestone = 'PF Paid'), 0)          as pf_amount,
           count(distinct ms.deal_id) filter (where ms.milestone = 'Disbursement')::bigint as disbursed,
           coalesce(sum(ms.amount) filter (where ms.milestone = 'Disbursement'), 0)     as disbursed_amount
    from ms group by ms.bd_key
  ),
  ch_agg as (
    select ch.bd_key, count(distinct ch.consultancy_id)::bigint as channels
    from ch group by ch.bd_key
  ),
  active_agg as (
    select ld.bd_key, count(distinct ld.consultancy_id)::bigint as active_channels
    from ld where ld.consultancy_id is not null group by ld.bd_key
  )
  select
    u.bd_key,
    n.bd_name,
    coalesce(ch_agg.channels, 0),
    coalesce(active_agg.active_channels, 0),
    coalesce(ld_agg.leads, 0),
    coalesce(ld_agg.lead_amount, 0),
    coalesce(ms_agg.logins, 0),
    coalesce(ms_agg.login_amount, 0),
    coalesce(ms_agg.sanctions, 0),
    coalesce(ms_agg.sanction_amount, 0),
    coalesce(ms_agg.pf_paid, 0),
    coalesce(ms_agg.pf_amount, 0),
    coalesce(ms_agg.disbursed, 0),
    coalesce(ms_agg.disbursed_amount, 0)
  from universe u
  -- `is not distinct from` rather than `=` so the NULL key (the
  -- '(Unattributed)' bucket) joins to its own aggregates instead of
  -- vanishing on a NULL comparison.
  left join names      n          on n.bd_key          is not distinct from u.bd_key
  left join ld_agg                on ld_agg.bd_key     is not distinct from u.bd_key
  left join ms_agg                on ms_agg.bd_key     is not distinct from u.bd_key
  left join ch_agg                on ch_agg.bd_key     is not distinct from u.bd_key
  left join active_agg            on active_agg.bd_key is not distinct from u.bd_key
  order by coalesce(ms_agg.disbursed_amount, 0) desc,
           coalesce(ld_agg.leads, 0) desc,
           n.bd_name nulls last
$$;

comment on function bd_performance(date, date) is
  'Per-BD leaderboard for a date window (NULL bounds = all time): channels, active channels, leads, logins, sanctions, PF paid, disbursed + amounts. security_invoker, so RLS scopes it to the caller.';


-- =========================================================
-- bd_performance_series(from, to, bucket) — the same metrics per time
-- bucket, for the daily / weekly / monthly matrix.
--
-- Bucketing happens in SQL rather than in the browser (the way
-- shared/js/trendsService.js does it for stage trends) because this
-- aggregates leads AND four milestone types across every BD at once —
-- pulling the raw rows to bucket them client-side would mean paging the
-- whole ledger on every granularity change.
--
-- date_trunc('week', …) starts weeks on Monday, matching startOfWeek() in
-- shared/js/trendsService.js — the two surfaces bucket identically.
-- =========================================================
create or replace function bd_performance_series(
  p_from   date,
  p_to     date,
  p_bucket text default 'month'
)
returns table (
  bd_key           text,
  bd_name          text,
  bucket_start     date,
  leads            bigint,
  logins           bigint,
  sanctions        bigint,
  pf_paid          bigint,
  disbursed        bigint,
  disbursed_amount numeric
)
language plpgsql
stable
security invoker   -- deliberately NOT security definer: must not bypass RLS
set search_path to 'public'
as $function$
begin
  if p_bucket not in ('day', 'week', 'month') then
    raise exception 'p_bucket must be one of day, week, month (got %)', p_bucket;
  end if;

  return query
  with events as (
    select v.bd_key, v.bd_name, 'Lead'::text as metric, v.lead_date as on_date,
           null::numeric as amount, v.lead_id as entity_id
    from v_bd_leads v
    where v.is_bd_scope and v.lead_date >= p_from and v.lead_date <= p_to
    union all
    select v.bd_key, v.bd_name, v.milestone, v.event_date, v.amount, v.deal_id
    from v_bd_milestones v
    where v.is_bd_scope and v.event_date >= p_from and v.event_date <= p_to
  )
  select
    e.bd_key,
    mode() within group (order by e.bd_name),
    date_trunc(p_bucket, e.on_date::timestamp)::date,
    -- count(distinct entity_id) for the same reason as bd_performance():
    -- a multi-tranche disbursement is one disbursed case, not two.
    count(distinct e.entity_id) filter (where e.metric = 'Lead')::bigint,
    count(distinct e.entity_id) filter (where e.metric = 'Login')::bigint,
    count(distinct e.entity_id) filter (where e.metric = 'Sanction')::bigint,
    count(distinct e.entity_id) filter (where e.metric = 'PF Paid')::bigint,
    count(distinct e.entity_id) filter (where e.metric = 'Disbursement')::bigint,
    coalesce(sum(e.amount) filter (where e.metric = 'Disbursement'), 0)
  from events e
  group by e.bd_key, date_trunc(p_bucket, e.on_date::timestamp)
  order by e.bd_key nulls last, 3;
end;
$function$;

comment on function bd_performance_series(date, date, text) is
  'Per-BD, per-bucket (day/week/month) counts of leads and each milestone, plus disbursed amount. security_invoker.';


-- =========================================================
-- send_bd_performance_report(from, to, label) — emails the leaderboard to
-- every active Admin and Manager.
--
-- NOT SCHEDULED. Nothing calls this until you create a cron entry; see
-- DEPLOYMENT.md → "BD performance report" for the snippets. It is defined
-- now so the reporting path is testable with a single SELECT.
--
-- SECURITY DEFINER, unlike everything else in this file, because cron has
-- no JWT: there is no caller for RLS to scope to. Running as the function
-- owner (which holds BYPASSRLS on Supabase) is what lets it see the whole
-- org, exactly as send_daily_digests() already does. It still calls
-- bd_performance() rather than re-deriving the numbers, so the emailed
-- table and the dashboard can never disagree.
--
-- ⚠ Delivery depends on NOTIFICATION_SECRET being set on the Edge
-- Function. It is currently UNSET on this project, so every send is
-- rejected 401 — see DEPLOYMENT.md → "Email notifications".
-- =========================================================
create or replace function send_bd_performance_report(
  p_from  date default null,
  p_to    date default null,
  p_label text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_label      text := coalesce(
                         p_label,
                         case when p_from is null then 'all time'
                              else to_char(p_from, 'DD Mon YYYY') || ' – ' || to_char(p_to, 'DD Mon YYYY') end);
  v_rows       text;
  v_totals     record;
  v_recipient  record;
begin
  select string_agg(
           format(
             '<tr><td>%s</td><td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
             || '<td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
             || '<td align="center">%s</td><td align="right">%s</td></tr>',
             html_escape(coalesce(r.bd_name, '(Unattributed)')),
             r.channels, r.active_channels, r.leads,
             r.logins, r.sanctions, r.pf_paid, r.disbursed,
             to_char(r.disbursed_amount, 'FM99,99,99,99,990')),
           '' order by r.disbursed_amount desc, r.leads desc, r.bd_name nulls last)
    into v_rows
  from bd_performance(p_from, p_to) r;

  -- No BD rows at all means nothing to report; sending an empty table
  -- trains people to ignore the mail.
  if v_rows is null then return; end if;

  select count(*)                    as bd_count,
         sum(r.channels)             as channels,
         sum(r.leads)                as leads,
         sum(r.logins)               as logins,
         sum(r.sanctions)            as sanctions,
         sum(r.pf_paid)              as pf_paid,
         sum(r.disbursed)            as disbursed,
         sum(r.disbursed_amount)     as disbursed_amount
    into v_totals
  from bd_performance(p_from, p_to) r;

  for v_recipient in
    select u.full_name, u.email
    from users u
    join roles r on r.id = u.role_id
    where r.name in ('Admin', 'Manager', 'Associate Team Manager')
      and u.is_active = true and u.is_deleted = false and u.email is not null
  loop
    perform notify_via_email(
      array[v_recipient.email],
      format('BD performance · %s · Zolve Tangent', v_label),
      format(
        '<p>Hi %s,</p>'
        || '<p><strong>BD performance — %s.</strong><br>'
        || '%s BD people · %s channels · %s leads · %s logins · %s sanctions · %s PF paid · '
        || '%s disbursed (₹%s).</p>'
        || '<table cellpadding="6" border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
        || '<tr style="background:#EEF2F7;"><th align="left">BD</th><th>Channels</th><th>Active</th><th>Leads</th>'
        || '<th>Logins</th><th>Sanctions</th><th>PF paid</th><th>Disbursed</th><th align="right">Disbursed ₹</th></tr>'
        || '%s</table>'
        || '<p style="color:#667085;font-size:12px;">Channels are the consultancies each BD owns; Active counts '
        || 'only those that produced a lead in this period. Leads are counted by creation date, milestones by '
        || 'their own recorded date.</p>',
        html_escape(v_recipient.full_name),
        html_escape(v_label),
        v_totals.bd_count, v_totals.channels, v_totals.leads, v_totals.logins,
        v_totals.sanctions, v_totals.pf_paid, v_totals.disbursed,
        to_char(v_totals.disbursed_amount, 'FM99,99,99,99,990'),
        v_rows)
    );
  end loop;
end;
$function$;

comment on function send_bd_performance_report(date, date, text) is
  'Emails the BD leaderboard to Admins/Managers. NOT scheduled — create a cron entry to use it. See DEPLOYMENT.md.';
