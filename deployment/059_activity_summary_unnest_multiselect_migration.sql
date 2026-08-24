-- =========================================================
-- 059 — Count each multiselect choice separately
--
-- 058's activity_form_summary() read a multiselect answer with `->>`, which
-- renders the whole array as one string. ["Friend","Classmate"] therefore
-- reported as a single answer "Friend, Classmate" rather than one response
-- for Friend and one for Classmate — so every distinct combination became
-- its own bar and the breakdown fell apart as soon as anyone picked two.
--
-- Unnests the array instead, so counts are per choice. Booleans now render
-- as Yes/No rather than true/false, since the chart labels are read by
-- people, not parsers.
-- =========================================================
create or replace function public.activity_form_summary(p_form_id uuid)
returns table (field_key text, label text, field_type text, answer text, responses bigint)
language sql security invoker set search_path to 'public' stable
as $function$
  select af.field_key, af.label, af.field_type, x.answer, count(*)
  from lead_activities a
  join activity_form_fields af on af.form_id = a.form_id and not af.is_deleted
  cross join lateral (
    select case
             when jsonb_typeof(a.values -> af.field_key) = 'boolean'
               then case when (a.values -> af.field_key)::boolean then 'Yes' else 'No' end
             else a.values ->> af.field_key
           end as answer
    where jsonb_typeof(a.values -> af.field_key) is distinct from 'array'
    union all
    select t
    from jsonb_array_elements_text(
           case when jsonb_typeof(a.values -> af.field_key) = 'array'
                then a.values -> af.field_key else '[]'::jsonb end) t
  ) x
  where a.form_id = p_form_id and not a.is_deleted and x.answer is not null
    and af.field_type in ('select','multiselect','checkbox','rating')
  group by af.field_key, af.label, af.field_type, x.answer, af.sort_order
  order by af.sort_order, count(*) desc;
$function$;

revoke all on function public.activity_form_summary(uuid) from public, anon;
grant execute on function public.activity_form_summary(uuid) to authenticated;
