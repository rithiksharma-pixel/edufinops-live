-- =========================================================
-- 073 - crm_search(): find a name whatever order the words are in
--
-- Lender files put the surname first. Ours do not, and not consistently:
-- Avanse's "Aktaben Vinodsinh Chavda" is our "Chavda Aktaben Vinodsinh",
-- their "Venkat Karthik Varala" is our "VARALA VENKAT KARTHIK". A substring
-- search finds neither, so pasting a name from a lender's report came back
-- empty for people sitting in the CRM the whole time.
--
-- A multi-word query now also matches when every word appears somewhere in
-- the name, in any order. The longest word is tested first as a plain
-- substring so the trigram index on student_name still does the narrowing;
-- the all-words check then runs only over what that leaves. A single word
-- behaves exactly as before — there is no order to be wrong about.
--
-- Deliberately word-containment, not fuzzy matching: "Varala" finds
-- "VARALA VENKAT KARTHIK" but "Varla" does not. A box that quietly returned
-- near-misses would be worse than one that returns nothing, because the
-- whole point is deciding whether a lender's case is ours.
-- =========================================================

create or replace function public.crm_search(p_q text, p_limit int default 20)
returns table (
  lead_id       uuid,
  deal_id       uuid,
  student_name  text,
  student_phone text,
  student_email text,
  consultancy   text,
  bd_name       text,
  rm_name       text,
  lead_stage    text,
  lender_name   text,
  login_id      text,
  matched_on    text
)
language sql stable security definer set search_path = public as $function$
  with q as (
    select raw, up, digits, tokens,
           -- the longest word, the most selective thing to hand the index;
           -- ties break arbitrarily and harmlessly
           (select t from unnest(tokens) t order by length(t) desc limit 1) as anchor
    from (
      select btrim(coalesce(p_q, ''))                             as raw,
             upper(btrim(coalesce(p_q, '')))                      as up,
             regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g') as digits,
             array_remove(
               string_to_array(
                 btrim(regexp_replace(lower(coalesce(p_q, '')), '[^a-z]+', ' ', 'g')), ' '),
               '')                                                as tokens
    ) s
  ),
  by_login as (
    select d.lead_id, d.id as deal_id, dld.login_id, 'Login ID'::text as matched_on, 0 as rank
    from q
    join deal_login_details dld
      on length(q.up) >= 3
     and upper(btrim(dld.login_id)) like q.up || '%'
    join deals d on d.id = dld.deal_id and not d.is_deleted
    where coalesce(dld.is_deleted, false) = false
    limit 200
  ),
  by_lead as (
    select l.id as lead_id, null::uuid as deal_id, null::text as login_id,
           case
             when length(q.digits) >= 4
              and (
                   (length(q.digits) >= 10
                    and right(regexp_replace(l.student_phone, '[^0-9]', '', 'g'), 10) = right(q.digits, 10))
                or (length(q.digits) < 10
                    and regexp_replace(l.student_phone, '[^0-9]', '', 'g') like '%' || q.digits || '%')
              )
               then 'Phone'
             when length(q.raw) >= 2 and l.student_name ilike '%' || q.raw || '%'
               then 'Name'
             when coalesce(array_length(q.tokens, 1), 0) >= 2
               then 'Name'
             else 'Email'
           end::text as matched_on,
           1 as rank,
           l.updated_at
    from q
    join leads l
      on not l.is_deleted
     and (
          (length(q.raw) >= 2 and l.student_name ilike '%' || q.raw || '%')
       -- same words, any order
       or (coalesce(array_length(q.tokens, 1), 0) >= 2
           and l.student_name ilike '%' || q.anchor || '%'
           and (select bool_and(lower(l.student_name) like '%' || t || '%') from unnest(q.tokens) t))
       or (length(q.digits) >= 10
           and right(regexp_replace(l.student_phone, '[^0-9]', '', 'g'), 10) = right(q.digits, 10))
       or (length(q.digits) between 4 and 9
           and regexp_replace(l.student_phone, '[^0-9]', '', 'g') like '%' || q.digits || '%')
       or (length(q.raw) >= 3 and coalesce(l.student_email, '') ilike '%' || q.raw || '%')
     )
    order by l.updated_at desc
    limit 200
  ),
  hits as (
    select lead_id, deal_id, login_id, matched_on, rank, null::timestamptz as updated_at from by_login
    union all
    select lead_id, deal_id, login_id, matched_on, rank, updated_at from by_lead
  ),
  visible as (
    select h.*
    from hits h
    where (select is_admin() or is_internal_staff())
       or can_view_lead(h.lead_id)
       or (h.deal_id is not null and can_view_deal(h.deal_id))
  )
  select distinct on (v.lead_id, coalesce(v.deal_id, '00000000-0000-0000-0000-000000000000'::uuid))
         v.lead_id, v.deal_id, l.student_name, l.student_phone, l.student_email,
         coalesce(c.name, nullif(l.consultancy_other_name, '')) as consultancy,
         l.bd_name, u.full_name as rm_name, g.name as lead_stage, ln.name as lender_name,
         v.login_id, v.matched_on
  from visible v
  join leads l on l.id = v.lead_id
  left join deals d          on d.id = v.deal_id
  left join lenders ln       on ln.id = d.lender_id
  left join consultancies c  on c.id = l.consultancy_id
  left join users u          on u.id = l.assigned_rm_id
  left join lead_stages g    on g.id = l.current_stage_id
  order by v.lead_id,
           coalesce(v.deal_id, '00000000-0000-0000-0000-000000000000'::uuid),
           v.rank,
           v.updated_at desc nulls last
  limit greatest(coalesce(p_limit, 20), 1);
$function$;

revoke all on function public.crm_search(text, int) from public;
grant execute on function public.crm_search(text, int) to authenticated;

-- ---------------------------------------------------------
-- Data, done once: five Avanse cases from their disbursement report that
-- were logged with the bank but never recorded here. The LAN list and the
-- name list arrived separately and in different orders; the pairing was
-- taken from position and checked against the eight cases that could be
-- matched independently by LAN — all eight agreed, so the remaining rows
-- follow the same correspondence. Two more (MUMEE01140241, HYDEE01188463)
-- were left alone: the student match for those is a partial name only.
--
--   HYDEE01194483  TEJASREE HAMSAVATH       SP ASSOCIATES / Sagar
--   HYDEE01197999  VEERAGONI CHANDU         ADHYA CONSULTANCY / Sagar
--   HYDEE01160348  VARALA VENKAT KARTHIK    Fly Abroad Edu / anuhya
--   DELEE01202268  Angelina Rao             Fund My Campus / Naveen Kumar JP
--   PUNEE01198705  SANDIP NAYAK             Subyahi Consultancy / Shivam Kumar
--
-- Each went through share_lead_with_lender() rather than a hand-written
-- insert, so the lender row, the deal and its Bank Prospect detail row were
-- created exactly as the app creates them, then the deal was set to Login
-- and the LAN written to deal_login_details.
-- ---------------------------------------------------------
