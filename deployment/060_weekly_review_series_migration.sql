-- =========================================================
-- 060 — Trailing weekly and monthly series for the review
--
-- The review could compare this week to last and this month to last, but had
-- no series behind it, so there was no trend to draw — only two bars. This
-- returns the trailing runs, which is what a "logins tripled since March"
-- line needs.
--
-- Kept separate from weekly_review_data so that large report stays
-- untouched; the client asks for both and merges them.
-- =========================================================
create or replace function public.weekly_review_series(
  p_week_end date default null,
  p_weeks    int  default 12,
  p_months   int  default 6
) returns jsonb
language sql security invoker set search_path to 'public' stable
as $function$
with bounds as (
  select coalesce(p_week_end, current_date) as wk_end
),
wk as (
  select gs::date as d_to, (gs::date - 6) as d_from, to_char(gs::date - 6, 'DD Mon') as label
  from bounds b,
       generate_series(
         (b.wk_end - (7 * (greatest(p_weeks,1) - 1)))::timestamp,
         b.wk_end::timestamp,
         interval '7 day') gs
),
mo as (
  select date_trunc('month', gs)::date as d_from,
         (date_trunc('month', gs) + interval '1 month' - interval '1 day')::date as d_to,
         to_char(gs, 'Mon YY') as label
  from bounds b,
       generate_series(
         (date_trunc('month', b.wk_end::timestamp) - ((greatest(p_months,1) - 1) || ' month')::interval),
         date_trunc('month', b.wk_end::timestamp),
         interval '1 month') gs
),
l as (
  select le.created_at::date as created_on, le.login_date, le.sanction_date,
         le.pf_date, le.disbursed_date
  from leads le where not le.is_deleted
)
select jsonb_build_object(
  'weeks', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'label', w.label, 'from', w.d_from, 'to', w.d_to,
      'leads',     (select count(*) from l where l.created_on    between w.d_from and w.d_to),
      'logins',    (select count(*) from l where l.login_date    between w.d_from and w.d_to),
      'sanctions', (select count(*) from l where l.sanction_date between w.d_from and w.d_to),
      'pf',        (select count(*) from l where l.pf_date       between w.d_from and w.d_to)
    ) order by w.d_from), '[]'::jsonb) from wk w),
  'months', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'label', m.label, 'from', m.d_from, 'to', m.d_to,
      'leads',     (select count(*) from l where l.created_on    between m.d_from and m.d_to),
      'logins',    (select count(*) from l where l.login_date    between m.d_from and m.d_to),
      'sanctions', (select count(*) from l where l.sanction_date between m.d_from and m.d_to),
      'pf',        (select count(*) from l where l.pf_date       between m.d_from and m.d_to)
    ) order by m.d_from), '[]'::jsonb) from mo m)
);
$function$;

revoke all on function public.weekly_review_series(date, int, int) from public, anon;
grant execute on function public.weekly_review_series(date, int, int) to authenticated;
