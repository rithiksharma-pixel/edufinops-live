-- =========================================================
-- 039 — Consultancy-wise reporting
--
-- Two functions behind the Reports page:
--   consultancy_report(from, to)        one row per consultancy, the rollup
--   consultancy_lead_detail(id, from, to)  the leads behind one consultancy
--
-- Both are SECURITY INVOKER (the default), so RLS decides what the caller
-- sees. There is deliberately no role logic here -- the database is the
-- scoping boundary, same as v_master_data and milestone_counts.
--
-- STAGE RANKING
--   lead_stages.sequence_order puts Lead Lost at 900, above Disbursement.
--   Every count here is written against the 10..70 pipeline band with Lead
--   Lost matched by name, so a lost lead can never be counted as "reached
--   Disbursement" by an accident of ordering.
--
--   The funnel counts are CUMULATIVE-BY-CURRENT-STAGE: a lead now at PF Paid
--   counts in login, sanction and pf_paid. That is what makes conversion
--   percentages meaningful. It understates real history -- a lead that
--   reached Login and was later lost counts only in `lost` -- because the
--   imported book carries no stage history to reconstruct from.
--
-- AGEING
--   days_since_activity is measured from last_activity_at, falling back to
--   created_at. For the 30 July imported book that is mostly the import date,
--   so ageing is only meaningful for leads worked since then. Flagged in the
--   UI rather than hidden.
-- =========================================================

create or replace function public.consultancy_report(
  p_from date default null,
  p_to   date default null
)
returns table (
  consultancy_id     uuid,
  consultancy_name   text,
  is_linked          boolean,
  total_leads        bigint,
  qualified          bigint,
  login              bigint,
  sanction           bigint,
  pf_paid            bigint,
  disbursement       bigint,
  lost               bigint,
  deals_created      bigint,
  sanctioned_amount  numeric,
  disbursed_amount   numeric,
  avg_age_days       numeric
)
language sql
stable
set search_path to 'public'
as $function$
  with scoped as (
    select l.id,
           l.consultancy_id,
           coalesce(c.name, nullif(btrim(l.consultancy_other_name), '')) as cname,
           c.id is not null as linked,
           s.name as stage,
           s.sequence_order as seq,
           coalesce(l.last_activity_at, l.created_at) as touched
    from leads l
    join lead_stages s on s.id = l.current_stage_id
    left join consultancies c on c.id = l.consultancy_id and not c.is_deleted
    where not l.is_deleted
      and (p_from is null or l.created_at >= p_from::timestamptz)
      and (p_to   is null or l.created_at <  (p_to + 1)::timestamptz)
  ),
  money as (
    select sc.consultancy_id, sc.cname,
           count(d.id)                                    as deals_created,
           sum(coalesce(sd.sanction_amount, 0))           as sanctioned,
           sum(coalesce(d.total_disbursed_amount, 0))     as disbursed
    from scoped sc
    join deals d on d.lead_id = sc.id and not d.is_deleted
    left join deal_sanction_details sd on sd.deal_id = d.id
    group by 1, 2
  )
  select
    sc.consultancy_id,
    sc.cname,
    bool_or(sc.linked),
    count(*)::bigint,
    count(*) filter (where sc.seq between 10 and 70)::bigint,
    count(*) filter (where sc.seq between 40 and 70)::bigint,
    count(*) filter (where sc.seq between 50 and 70)::bigint,
    count(*) filter (where sc.seq between 60 and 70)::bigint,
    count(*) filter (where sc.seq = 70)::bigint,
    count(*) filter (where sc.stage = 'Lead Lost')::bigint,
    coalesce(max(m.deals_created), 0)::bigint,
    coalesce(max(m.sanctioned), 0),
    coalesce(max(m.disbursed), 0),
    round(avg(extract(epoch from (now() - sc.touched)) / 86400)::numeric, 1)
  from scoped sc
  left join money m
         on m.cname = sc.cname
        and m.consultancy_id is not distinct from sc.consultancy_id
  where sc.cname is not null
  group by sc.consultancy_id, sc.cname
  order by count(*) desc;
$function$;

comment on function public.consultancy_report(date, date) is
  'Per-consultancy funnel, conversion inputs, deal value and ageing. RLS-scoped to the caller.';


create or replace function public.consultancy_lead_detail(
  p_consultancy_id uuid,
  p_consultancy_name text default null,
  p_from date default null,
  p_to   date default null
)
returns table (
  student_name   text,
  student_phone  text,
  student_email  text,
  stage          text,
  assigned_rm    text,
  loan_amount    numeric,
  created_on     date,
  last_activity  date,
  days_idle      integer
)
language sql
stable
set search_path to 'public'
as $function$
  select l.student_name, l.student_phone, l.student_email,
         s.name,
         u.full_name,
         l.loan_amount_requested,
         l.created_at::date,
         coalesce(l.last_activity_at, l.created_at)::date,
         extract(day from (now() - coalesce(l.last_activity_at, l.created_at)))::int
  from leads l
  join lead_stages s on s.id = l.current_stage_id
  left join users u on u.id = l.assigned_rm_id
  left join consultancies c on c.id = l.consultancy_id and not c.is_deleted
  where not l.is_deleted
    and (
      (p_consultancy_id is not null and l.consultancy_id = p_consultancy_id)
      or (p_consultancy_id is null and p_consultancy_name is not null
          and nullif(btrim(l.consultancy_other_name), '') = p_consultancy_name)
    )
    and (p_from is null or l.created_at >= p_from::timestamptz)
    and (p_to   is null or l.created_at <  (p_to + 1)::timestamptz)
  order by s.sequence_order desc, l.created_at desc;
$function$;

comment on function public.consultancy_lead_detail(uuid, text, date, date) is
  'Lead-level rows behind one consultancy row of consultancy_report(). RLS-scoped.';
