-- =========================================================
-- 050 — BD-manager-wise reporting
--
-- The Partner Reports page answers "how is this consultancy doing".
-- This answers "how is this BD person's book doing", which is a different
-- cut of the same leads: one BD manager owns many consultancies.
--
--   bd_report(from, to, date_field)          one row per BD person
--   bd_lead_detail(bd, from, to, date_field) the leads behind one row
--
-- Both SECURITY INVOKER, so RLS decides what the caller sees — same
-- contract as consultancy_report(). Counts use the 10..70 pipeline band
-- with Lead Lost matched BY NAME, because lead_stages.sequence_order puts
-- Lead Lost at 900, above Disbursement.
--
-- HOW A LEAD IS ATTRIBUTED TO A BD PERSON  (first match wins)
--   1. leads.bd_name              — captured at lead creation, most precise
--   2. consultancies.bd_manager via leads.consultancy_id
--   3. consultancies.bd_manager via a name match on consultancy_other_name
--
-- Why the fallbacks: migration 026 deliberately never backfilled bd_name,
-- so it is set on only ~334 of 12,651 leads. consultancies.bd_manager, by
-- contrast, is filled on 809 of 813 consultancies. Without the fallback
-- this report would cover 3% of the book instead of ~45%.
--
-- Step 3 matches on lower(btrim(name)) because the bulk imports wrote the
-- consultancy as free text into consultancy_other_name rather than linking
-- it. It is applied ONLY when consultancy_id is null, so a real link is
-- never overridden by a name collision.
--
-- UNATTRIBUTED IS RETURNED, NOT DROPPED
--   ~6,900 imported leads resolve to no BD person at all. They come back as
--   a single row with bd_manager = null so the page can show them. Hiding
--   them would make every BD person's share of the book look bigger than
--   it is, and the totals would not reconcile against Lead Management.
-- =========================================================

create or replace function public.bd_report(
  p_from       date default null,
  p_to         date default null,
  p_date_field text default 'created_at'
)
returns table (
  bd_manager        text,
  consultancies     bigint,
  total_leads       bigint,
  qualified         bigint,
  login             bigint,
  sanction          bigint,
  pf_paid           bigint,
  disbursement      bigint,
  lost              bigint,
  deals_created     bigint,
  sanctioned_amount numeric,
  disbursed_amount  numeric,
  avg_age_days      numeric
)
language sql stable set search_path to 'public'
as $function$
  with scoped as (
    select l.id,
           coalesce(
             nullif(btrim(l.bd_name), ''),
             nullif(btrim(c1.bd_manager), ''),
             nullif(btrim(c2.bd_manager), '')
           ) as bd,
           coalesce(c1.name, nullif(btrim(l.consultancy_other_name), '')) as cname,
           s.name as stage, s.sequence_order as seq,
           coalesce(l.last_activity_at, l.created_at) as touched
    from leads l
    join lead_stages s on s.id = l.current_stage_id
    left join consultancies c1 on c1.id = l.consultancy_id and not c1.is_deleted
    -- name fallback, only where there is no real link to override
    left join consultancies c2 on lower(btrim(c2.name)) = lower(btrim(l.consultancy_other_name))
                              and not c2.is_deleted and l.consultancy_id is null
    where not l.is_deleted
      and (p_from is null or
           (case p_date_field
              when 'updated_at'     then l.updated_at::date
              when 'login_date'     then l.login_date
              when 'sanction_date'  then l.sanction_date
              when 'pf_date'        then l.pf_date
              when 'disbursed_date' then l.disbursed_date
              else l.created_at::date end) >= p_from)
      and (p_to is null or
           (case p_date_field
              when 'updated_at'     then l.updated_at::date
              when 'login_date'     then l.login_date
              when 'sanction_date'  then l.sanction_date
              when 'pf_date'        then l.pf_date
              when 'disbursed_date' then l.disbursed_date
              else l.created_at::date end) <= p_to)
      and (p_date_field not in ('login_date','sanction_date','pf_date','disbursed_date')
           or (case p_date_field
                 when 'login_date'     then l.login_date
                 when 'sanction_date'  then l.sanction_date
                 when 'pf_date'        then l.pf_date
                 else l.disbursed_date end) is not null)
  ),
  money as (
    select sc.bd,
           count(d.id) as deals_created,
           sum(coalesce(sd.sanction_amount, 0)) as sanctioned,
           sum(coalesce(d.total_disbursed_amount, 0)) as disbursed
    from scoped sc
    join deals d on d.lead_id = sc.id and not d.is_deleted
    left join deal_sanction_details sd on sd.deal_id = d.id
    group by 1
  )
  select sc.bd,
    count(distinct sc.cname)::bigint,
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
  left join money m on m.bd is not distinct from sc.bd
  group by sc.bd
  -- nulls last so "Unattributed" sits at the foot, not the head
  order by (sc.bd is null), count(*) desc;
$function$;

comment on function public.bd_report(date, date, text) is
  'Per-BD-manager funnel, deal value and ageing. Attribution: lead.bd_name, else the consultancy''s bd_manager. RLS-scoped.';


create or replace function public.bd_lead_detail(
  p_bd_manager text,
  p_from       date default null,
  p_to         date default null,
  p_date_field text default 'created_at'
)
returns table (
  student_name  text,
  student_phone text,
  student_email text,
  consultancy   text,
  stage         text,
  assigned_rm   text,
  loan_amount   numeric,
  created_on    date,
  last_activity date,
  days_idle     integer
)
language sql stable set search_path to 'public'
as $function$
  select l.student_name, l.student_phone, l.student_email,
         coalesce(c1.name, nullif(btrim(l.consultancy_other_name), '')),
         s.name,
         u.full_name,
         l.loan_amount_requested,
         l.created_at::date,
         coalesce(l.last_activity_at, l.created_at)::date,
         extract(day from (now() - coalesce(l.last_activity_at, l.created_at)))::int
  from leads l
  join lead_stages s on s.id = l.current_stage_id
  left join users u on u.id = l.assigned_rm_id
  left join consultancies c1 on c1.id = l.consultancy_id and not c1.is_deleted
  left join consultancies c2 on lower(btrim(c2.name)) = lower(btrim(l.consultancy_other_name))
                            and not c2.is_deleted and l.consultancy_id is null
  where not l.is_deleted
    -- null p_bd_manager means the Unattributed bucket, so this must be
    -- IS NOT DISTINCT FROM rather than =
    and coalesce(
          nullif(btrim(l.bd_name), ''),
          nullif(btrim(c1.bd_manager), ''),
          nullif(btrim(c2.bd_manager), '')
        ) is not distinct from nullif(btrim(p_bd_manager), '')
    and (p_from is null or
         (case p_date_field
            when 'updated_at'     then l.updated_at::date
            when 'login_date'     then l.login_date
            when 'sanction_date'  then l.sanction_date
            when 'pf_date'        then l.pf_date
            when 'disbursed_date' then l.disbursed_date
            else l.created_at::date end) >= p_from)
    and (p_to is null or
         (case p_date_field
            when 'updated_at'     then l.updated_at::date
            when 'login_date'     then l.login_date
            when 'sanction_date'  then l.sanction_date
            when 'pf_date'        then l.pf_date
            when 'disbursed_date' then l.disbursed_date
            else l.created_at::date end) <= p_to)
    and (p_date_field not in ('login_date','sanction_date','pf_date','disbursed_date')
         or (case p_date_field
               when 'login_date'     then l.login_date
               when 'sanction_date'  then l.sanction_date
               when 'pf_date'        then l.pf_date
               else l.disbursed_date end) is not null)
  order by s.sequence_order desc, l.created_at desc;
$function$;

comment on function public.bd_lead_detail(text, date, date, text) is
  'Lead-level rows behind one row of bd_report(). Pass null for the Unattributed bucket. RLS-scoped.';
