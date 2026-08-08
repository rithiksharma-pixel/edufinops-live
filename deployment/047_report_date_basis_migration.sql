-- =========================================================
-- 047 — Date basis on Partner Reports
--
-- The report window was hardwired to created_at, so "how many of their leads
-- logged in during August" was unanswerable. Same whitelist the lead list
-- uses, against the columns 045 denormalised onto the lead. An unrecognised
-- value falls through to created_at, so it can never be used as an arbitrary
-- column name. A milestone basis only counts leads that actually reached it.
--
-- IMPORTANT — adding p_date_field CHANGES THE SIGNATURE, so `create or
-- replace` does not replace: it creates a SECOND OVERLOAD beside the old one.
-- Both stay live, and PostgREST resolves by the arguments it is sent, so any
-- caller omitting p_date_field would silently hit the old created_at-only
-- version and the new date basis would look like it simply did not work.
-- The pre-047 signatures are dropped at the end of this file.
-- =========================================================

create or replace function public.consultancy_report(
  p_from       date default null,
  p_to         date default null,
  p_date_field text default 'created_at'
)
returns table (
  consultancy_id uuid, consultancy_name text, is_linked boolean,
  total_leads bigint, qualified bigint, login bigint, sanction bigint,
  pf_paid bigint, disbursement bigint, lost bigint, deals_created bigint,
  sanctioned_amount numeric, disbursed_amount numeric, avg_age_days numeric
)
language sql stable set search_path to 'public'
as $function$
  with scoped as (
    select l.id, l.consultancy_id,
           coalesce(c.name, nullif(btrim(l.consultancy_other_name), '')) as cname,
           c.id is not null as linked,
           s.name as stage, s.sequence_order as seq,
           coalesce(l.last_activity_at, l.created_at) as touched
    from leads l
    join lead_stages s on s.id = l.current_stage_id
    left join consultancies c on c.id = l.consultancy_id and not c.is_deleted
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
      -- A milestone basis only makes sense for leads that reached it.
      and (p_date_field not in ('login_date','sanction_date','pf_date','disbursed_date')
           or (case p_date_field
                 when 'login_date'     then l.login_date
                 when 'sanction_date'  then l.sanction_date
                 when 'pf_date'        then l.pf_date
                 else l.disbursed_date end) is not null)
  ),
  money as (
    select sc.consultancy_id, sc.cname,
           count(d.id) as deals_created,
           sum(coalesce(sd.sanction_amount, 0)) as sanctioned,
           sum(coalesce(d.total_disbursed_amount, 0)) as disbursed
    from scoped sc
    join deals d on d.lead_id = sc.id and not d.is_deleted
    left join deal_sanction_details sd on sd.deal_id = d.id
    group by 1, 2
  )
  select sc.consultancy_id, sc.cname, bool_or(sc.linked),
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
  left join money m on m.cname = sc.cname
       and m.consultancy_id is not distinct from sc.consultancy_id
  where sc.cname is not null
  group by sc.consultancy_id, sc.cname
  order by count(*) desc;
$function$;

create or replace function public.consultancy_lead_detail(
  p_consultancy_id uuid,
  p_consultancy_name text default null,
  p_from date default null,
  p_to   date default null,
  p_date_field text default 'created_at'
)
returns table (
  student_name text, student_phone text, student_email text, stage text,
  assigned_rm text, loan_amount numeric, created_on date, last_activity date,
  days_idle integer
)
language sql stable set search_path to 'public'
as $function$
  select l.student_name, l.student_phone, l.student_email, s.name, u.full_name,
         l.loan_amount_requested, l.created_at::date,
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

-- Applied separately as 047b. Without this BOTH overloads stay live and a
-- caller omitting p_date_field silently gets the old created_at-only version.
drop function if exists public.consultancy_report(date, date);
drop function if exists public.consultancy_lead_detail(uuid, text, date, date);
