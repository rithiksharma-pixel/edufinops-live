-- =========================================================
-- 072 - One search box: name, phone, email or lender login ID
--
-- A lender sends a list of their own login IDs (Credila "A2608215209",
-- Avanse "BANEE01184659") and asks which are ours. The ID was already in
-- the CRM all along, on the bank case as Login ID — 2,346 of them — but
-- nothing searched it: the lead list searches names, find_leads_by_phone()
-- searches phones, and the login ID was reachable only by opening a lead
-- and clicking into its Login stage. So reconciling a lender's list meant
-- guessing at student names, which for a "Rahul" or an "Ajay" cannot work.
--
-- crm_search() takes whatever is pasted and works out what it is:
--   * looks like an ID       -> prefix match on the bank case's Login ID
--   * ten digits or more     -> phone, matched on the LAST TEN digits, so a
--                               number copied as "+91 96395 79237" lands on
--                               the stored "9639579237" (the same key the
--                               lead import and find_leads_by_phone dedupe
--                               on). A substring test failed here: with the
--                               country code the needle is longer than the
--                               haystack.
--   * four to nine digits    -> substring, so the last four digits work
--   * anything else          -> student name or email
-- A login ID hit ranks first because it identifies exactly one case, and it
-- carries its lender and deal so the caller can open that case.
--
-- Authorisation is per row and reuses what already decides this elsewhere:
-- can_view_lead for internal staff, can_view_deal so a bank's own officer
-- can look up their own login ID without being given sight of anyone
-- else's. Verified by impersonation: an ICICI officer searching an Avanse
-- login ID gets nothing, and a broad name search gets nothing, while their
-- own case comes back.
--
-- Two things keep it quick. Internal staff may see every lead — the rule
-- the leads table itself has enforced since 035 — so that is settled once
-- as a scalar subquery rather than re-asked per row; the first cut called
-- can_view_lead() per candidate, which reaches into
-- rm_reports_to_current_manager() and timed out on a two-letter query. And
-- each match arm caps its candidates before authorisation runs, bounding
-- the work for a Lender, the one caller still needing a per-row decision.
--
-- SECURITY DEFINER is needed because a Lender has no SELECT on leads at all
-- (the same reason lender_pipeline() exists in 065).
-- =========================================================

create index if not exists idx_deal_login_details_login_id_upper
  on deal_login_details (upper(btrim(login_id)))
  where login_id is not null;

create index if not exists idx_leads_phone_digits
  on leads (regexp_replace(student_phone, '[^0-9]', '', 'g'));

create extension if not exists pg_trgm;
create index if not exists idx_leads_student_name_trgm
  on leads using gin (student_name gin_trgm_ops);

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
    select btrim(coalesce(p_q, ''))                             as raw,
           upper(btrim(coalesce(p_q, '')))                      as up,
           regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g') as digits
  ),
  -- A login ID names exactly one bank case, so it is matched first and
  -- carries its deal through. Prefix, not substring: these IDs are pasted
  -- whole, and a substring scan would rank a coincidence in the middle of
  -- some unrelated number alongside a real hit.
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
             else 'Email'
           end::text as matched_on,
           1 as rank,
           l.updated_at
    from q
    join leads l
      on not l.is_deleted
     and (
          (length(q.raw) >= 2 and l.student_name ilike '%' || q.raw || '%')
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
         v.lead_id,
         v.deal_id,
         l.student_name,
         l.student_phone,
         l.student_email,
         coalesce(c.name, nullif(l.consultancy_other_name, '')) as consultancy,
         l.bd_name,
         u.full_name  as rm_name,
         g.name       as lead_stage,
         ln.name      as lender_name,
         v.login_id,
         v.matched_on
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
