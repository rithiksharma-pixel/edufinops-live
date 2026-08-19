-- =========================================================
-- 057 — Weekly Business Review
--
-- One RPC that returns every number the review needs as a single JSON
-- document, plus two small tables: targets (so Target vs Achievement has
-- something to compare against) and a store for generated reviews.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- The brief asks for a P&L dashboard (revenue, costs, margin, unit
-- economics) and an Invoicing dashboard (generated/pending/collected,
-- receivables ageing). There is no revenue, cost, commission, invoice or
-- payment data anywhere in this database — not thin data, none. Those
-- sections return `available: false` with the reason, and the deck renders
-- an honest gap panel. Inventing figures for a board pack is not a
-- reasonable default.
--
-- Money that DOES exist is disbursed volume: deals.total_disbursed_amount
-- (3 rows) and leads.disbursed_amount (added in 055, still empty). Both are
-- reported as volume, never as revenue.
--
-- Metric basis, so every section counts the same way:
--   leads       — created_at within the period
--   logins      — login_date within the period
--   sanctions   — sanction_date within the period
--   pf          — pf_date within the period
--   disbursals  — disbursed_date within the period
-- Milestone dates are used rather than current stage, so a lead counts in
-- the week the thing actually happened. Leads that reached a stage with no
-- date recorded are reported separately as `undated` rather than silently
-- dropped — there are ~175 of those at Login (see the BD reporting work).
-- =========================================================

-- ---------- Targets ----------
create table if not exists public.review_targets (
  id            uuid primary key default gen_random_uuid(),
  period_type   text not null check (period_type in ('week','month')),
  period_start  date not null,
  -- null owner_id = a team-level target for the whole business
  owner_id      uuid references public.users(id),
  metric        text not null check (metric in ('leads','logins','sanctions','pf','disbursals','disbursed_value')),
  target_value  numeric(14,2) not null check (target_value >= 0),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  updated_at    timestamptz not null default now(),
  unique (period_type, period_start, owner_id, metric)
);

create index if not exists idx_review_targets_period
  on public.review_targets(period_type, period_start);

alter table public.review_targets enable row level security;

drop policy if exists review_targets_read on public.review_targets;
create policy review_targets_read on public.review_targets
  for select to authenticated using ((select public.is_internal_staff()));

drop policy if exists review_targets_write on public.review_targets;
create policy review_targets_write on public.review_targets
  for all to authenticated
  using ((select public.is_admin_or_manager()))
  with check ((select public.is_admin_or_manager()));

-- ---------- Stored reviews ----------
create table if not exists public.weekly_reviews (
  id            uuid primary key default gen_random_uuid(),
  week_start    date not null,
  week_end      date not null,
  title         text not null,
  payload       jsonb not null,
  generated_at  timestamptz not null default now(),
  generated_by  uuid references public.users(id),
  is_deleted    boolean not null default false
);

create index if not exists idx_weekly_reviews_week
  on public.weekly_reviews(week_end desc) where is_deleted = false;

alter table public.weekly_reviews enable row level security;

drop policy if exists weekly_reviews_read on public.weekly_reviews;
create policy weekly_reviews_read on public.weekly_reviews
  for select to authenticated using ((select public.is_internal_staff()));

drop policy if exists weekly_reviews_write on public.weekly_reviews;
create policy weekly_reviews_write on public.weekly_reviews
  for all to authenticated
  using ((select public.is_admin_or_manager()))
  with check ((select public.is_admin_or_manager()));

-- ---------- The report ----------
create or replace function public.weekly_review_data(p_week_end date default null)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
-- Not STABLE: it builds a temp table, which is a write. Marking it stable
-- would be a lie the planner is entitled to act on.
as $function$
declare
  v_wk_end     date := coalesce(p_week_end, current_date);
  v_wk_start   date := v_wk_end - 6;
  v_pw_end     date := v_wk_start - 1;
  v_pw_start   date := v_pw_end - 6;
  v_mo_start   date := date_trunc('month', v_wk_end)::date;
  v_mo_end     date := v_wk_end;
  v_pm_start   date := (date_trunc('month', v_wk_end) - interval '1 month')::date;
  v_pm_end     date := (date_trunc('month', v_wk_end) - interval '1 day')::date;
  v_result     jsonb;
begin
  -- One pass over leads, decorated with everything downstream needs.
  create temp table _wr_lead on commit drop as
  select
    l.id,
    l.created_at::date            as created_on,
    l.login_date, l.sanction_date, l.pf_date, l.disbursed_date,
    l.disbursed_amount,
    l.assigned_rm_id              as owner_id,
    coalesce(u.full_name, 'Unassigned') as owner_name,
    st.name                       as stage_name,
    st.sequence_order             as stage_seq,
    src.name                      as source_name,
    l.lost_reason_id is not null or st.name = 'Lead Lost' as is_lost,
    coalesce(nullif(btrim(l.bd_name),''), nullif(btrim(c1.bd_manager),''),
             nullif(btrim(c2.bd_manager),'')) as bd_name,
    -- last_activity_at is populated on almost no rows, so touchbase is
    -- derived from the newest real event instead.
    greatest(coalesce(ev.last_event, l.created_at), l.created_at)::date as last_touch
  from leads l
  join lead_stages st  on st.id  = l.current_stage_id
  join lead_sources src on src.id = l.lead_source_id
  left join users u on u.id = l.assigned_rm_id
  left join consultancies c1 on c1.id = l.consultancy_id and not c1.is_deleted
  left join consultancies c2 on lower(btrim(c2.name)) = lower(btrim(l.consultancy_other_name))
                            and not c2.is_deleted and l.consultancy_id is null
  left join lateral (
    select max(e.created_at) as last_event
    from lead_events e where e.lead_id = l.id and not e.is_deleted
  ) ev on true
  where not l.is_deleted;

  create index on _wr_lead (owner_id);
  create index on _wr_lead (bd_name);

  with
  -- ---------- period metrics ----------
  periods(label, d_from, d_to) as (
    values ('current_week', v_wk_start, v_wk_end),
           ('previous_week', v_pw_start, v_pw_end),
           ('current_month', v_mo_start, v_mo_end),
           ('previous_month', v_pm_start, v_pm_end)
  ),
  period_metrics as (
    select p.label,
      p.d_from, p.d_to,
      count(*) filter (where l.created_on   between p.d_from and p.d_to) as leads,
      count(*) filter (where l.login_date   between p.d_from and p.d_to) as logins,
      count(*) filter (where l.sanction_date between p.d_from and p.d_to) as sanctions,
      count(*) filter (where l.pf_date      between p.d_from and p.d_to) as pf,
      count(*) filter (where l.disbursed_date between p.d_from and p.d_to) as disbursals,
      coalesce(sum(l.disbursed_amount) filter (where l.disbursed_date between p.d_from and p.d_to), 0) as disbursed_value
    from periods p left join _wr_lead l on true
    group by p.label, p.d_from, p.d_to
  ),
  -- ---------- owner-wise ----------
  owner_rows as (
    select coalesce(l.owner_name,'Unassigned') as owner,
      count(*) as leads_all,
      count(*) filter (where l.login_date is not null or l.stage_seq between 40 and 70) as logins_all,
      count(*) filter (where l.pf_date is not null or l.stage_seq >= 60) as pf_all,
      count(*) filter (where l.created_on between v_wk_start and v_wk_end) as leads_wk,
      count(*) filter (where l.login_date between v_wk_start and v_wk_end) as logins_wk,
      count(*) filter (where l.pf_date   between v_wk_start and v_wk_end) as pf_wk,
      count(*) filter (where l.created_on between v_pw_start and v_pw_end) as leads_pw,
      count(*) filter (where l.login_date between v_pw_start and v_pw_end) as logins_pw,
      count(*) filter (where l.created_on between v_mo_start and v_mo_end) as leads_mo,
      count(*) filter (where l.login_date between v_mo_start and v_mo_end) as logins_mo,
      count(*) filter (where l.pf_date   between v_mo_start and v_mo_end) as pf_mo,
      count(*) filter (where l.created_on between v_pm_start and v_pm_end) as leads_pm,
      count(*) filter (where l.login_date between v_pm_start and v_pm_end) as logins_pm,
      count(*) filter (where l.pf_date   between v_pm_start and v_pm_end) as pf_pm
    from _wr_lead l group by 1
  ),
  -- ---------- BD-wise ----------
  bd_rows as (
    select coalesce(l.bd_name,'(no BD)') as bd,
      count(*) as leads_all,
      count(*) filter (where l.login_date is not null or l.stage_seq between 40 and 70) as logins_all,
      count(*) filter (where l.pf_date is not null or l.stage_seq >= 60) as pf_all,
      count(*) filter (where l.created_on between v_wk_start and v_wk_end) as leads_wk,
      count(*) filter (where l.login_date between v_wk_start and v_wk_end) as logins_wk,
      count(*) filter (where l.created_on between v_pw_start and v_pw_end) as leads_pw,
      count(*) filter (where l.login_date between v_pw_start and v_pw_end) as logins_pw,
      count(*) filter (where l.created_on between v_mo_start and v_mo_end) as leads_mo,
      count(*) filter (where l.login_date between v_mo_start and v_mo_end) as logins_mo,
      count(*) filter (where l.created_on between v_pm_start and v_pm_end) as leads_pm,
      count(*) filter (where l.login_date between v_pm_start and v_pm_end) as logins_pm
    from _wr_lead l
    where l.source_name = 'BD Partnership'
    group by 1
  ),
  -- ---------- funnel ----------
  funnel as (
    select
      count(*) as total_leads,
      count(*) filter (where stage_seq >= 20 and not is_lost) as app_start,
      count(*) filter (where stage_seq >= 30 and not is_lost) as bank_prospect,
      count(*) filter (where login_date is not null or stage_seq between 40 and 70) as login,
      count(*) filter (where sanction_date is not null or stage_seq between 50 and 70) as sanction,
      count(*) filter (where pf_date is not null or stage_seq >= 60) as pf,
      count(*) filter (where disbursed_date is not null or stage_seq = 70) as disbursed,
      count(*) filter (where is_lost) as lost,
      count(*) filter (where (login_date is null) and stage_seq between 40 and 70) as login_undated,
      count(*) filter (where (pf_date is null) and stage_seq >= 60 and stage_seq < 900) as pf_undated
    from _wr_lead
  ),
  -- ---------- TAT (only where both ends are real dates) ----------
  tat as (
    select
      round(avg(login_date - created_on) filter (where login_date is not null and login_date >= created_on), 1) as create_to_login,
      round(avg(sanction_date - login_date) filter (where sanction_date is not null and login_date is not null and sanction_date >= login_date), 1) as login_to_sanction,
      round(avg(pf_date - sanction_date) filter (where pf_date is not null and sanction_date is not null and pf_date >= sanction_date), 1) as sanction_to_pf,
      round(avg(disbursed_date - pf_date) filter (where disbursed_date is not null and pf_date is not null and disbursed_date >= pf_date), 1) as pf_to_disbursal
    from _wr_lead
  ),
  -- ---------- ageing + touchbase ----------
  buckets as (
    select
      case when v_wk_end - last_touch <= 7  then '0-7 days'
           when v_wk_end - last_touch <= 14 then '8-14 days'
           when v_wk_end - last_touch <= 30 then '15-30 days'
           when v_wk_end - last_touch <= 60 then '31-60 days'
           else '60+ days' end as touch_bucket,
      case when v_wk_end - created_on <= 7  then '0-7 days'
           when v_wk_end - created_on <= 30 then '8-30 days'
           when v_wk_end - created_on <= 60 then '31-60 days'
           when v_wk_end - created_on <= 90 then '61-90 days'
           else '90+ days' end as age_bucket,
      owner_name, stage_name, is_lost
    from _wr_lead
  ),
  touch_overall as (
    select touch_bucket as bucket, count(*) as leads
    from buckets where not is_lost group by 1
  ),
  age_overall as (
    select age_bucket as bucket, stage_name, count(*) as leads
    from buckets where not is_lost group by 1,2
  ),
  touch_by_owner as (
    select owner_name as owner, touch_bucket as bucket, count(*) as leads
    from buckets where not is_lost group by 1,2
  ),
  -- ---------- targets ----------
  target_rows as (
    select t.metric, t.period_type, coalesce(u.full_name,'(team)') as owner,
           t.owner_id, t.target_value
    from review_targets t left join users u on u.id = t.owner_id
    where (t.period_type = 'week'  and t.period_start = v_wk_start)
       or (t.period_type = 'month' and t.period_start = v_mo_start)
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'week_start', v_wk_start, 'week_end', v_wk_end,
      'prev_week_start', v_pw_start, 'prev_week_end', v_pw_end,
      'month_start', v_mo_start, 'month_end', v_mo_end,
      'prev_month_start', v_pm_start, 'prev_month_end', v_pm_end,
      'generated_at', now()
    ),
    'periods',      (select jsonb_object_agg(label, to_jsonb(pm) - 'label') from period_metrics pm),
    'owners',       (select coalesce(jsonb_agg(to_jsonb(o) order by o.leads_all desc), '[]'::jsonb) from owner_rows o),
    'bd',           (select coalesce(jsonb_agg(to_jsonb(b) order by b.leads_all desc), '[]'::jsonb) from bd_rows b),
    'funnel',       (select to_jsonb(f) from funnel f),
    'tat',          (select to_jsonb(t) from tat t),
    'touchbase',    (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from touch_overall x),
    'ageing',       (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from age_overall x),
    'touch_owner',  (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from touch_by_owner x),
    'targets',      (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from target_rows x),
    -- Sections with no data source. The client renders the reason rather
    -- than a chart, so the gap is visible in the deck instead of hidden.
    'pnl', jsonb_build_object(
      'available', false,
      'reason', 'No revenue, cost or commission data exists in the CRM. A P&L needs a commission structure per consultancy or lender (percentage of disbursed, flat fee, or slab), plus a cost ledger. Neither has been set up.'
    ),
    'invoicing', jsonb_build_object(
      'available', false,
      'reason', 'No invoice or payment records exist in the CRM. Invoicing needs tables for issued invoices, their line items and payment state before generated / pending / collected / receivables ageing can be reported.'
    ),
    'data_quality', jsonb_build_object(
      'users_total',      (select count(*) from users where not is_deleted and status='active'),
      'users_with_team',  (select count(*) from users where not is_deleted and status='active' and team_id is not null),
      'leads_no_owner',   (select count(*) from _wr_lead where owner_id is null),
      'deals_with_value', (select count(*) from deals where not is_deleted and total_disbursed_amount > 0),
      'disbursed_value_recorded', (select coalesce(sum(disbursed_amount),0) from _wr_lead)
    )
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.weekly_review_data(date) from public, anon;
grant execute on function public.weekly_review_data(date) to authenticated;
