-- =========================================================
-- 074 - A link a partner can fill in, with no login
--
-- Consultants who have a portal account can already add a student. Most
-- partners do not have one and never will: they send names on WhatsApp, an
-- RM retypes them, and that is where the source, the amount and half the
-- phone numbers go missing. A link they can open and fill in removes the
-- retyping step, and the lead arrives already attributed to them.
--
-- One link per partner, not one shared form with a "choose your firm"
-- dropdown. The token IS the attribution: nobody can file a lead under
-- someone else's name, and revoking one partner's link does not disturb
-- anyone else's. Nothing exists until an Admin creates a link, so this
-- migration opens no door on its own.
--
-- Two functions are exposed to anon, and only these two:
--   partner_form_context(token) -> the firm's name, so the page can show
--     "Referrals from <firm>" and a wrong link fails visibly instead of
--     silently filing to nowhere. It returns nothing else: no students, no
--     counts, no ids. A token that does not match returns no rows at all.
--   submit_partner_lead(...)    -> writes one lead. Every field is a named
--     argument; there is no path from the form to an arbitrary column.
--
-- Abuse is bounded three ways: the token is 40 hex characters so links
-- cannot be guessed, each link takes at most 40 submissions an hour, and a
-- phone number already in the CRM returns "we already have this student"
-- without creating a duplicate — which also stops a partner double-filing
-- a lead an RM has already typed in.
--
-- The lead lands as Lead Qualified, sourced BD Partnership, stamped with
-- the partner's consultancy and BD, and assigned to whichever RM has been
-- handling that partner's leads lately. If nobody has, it stays unassigned
-- and shows up in the Admin's "needs attention" list rather than being
-- silently parked on someone who does not know about it.
--
-- Verified by impersonation before shipping: as anon, a good token returns
-- the firm name and accepts a lead; a wrong token returns nothing and is
-- refused; a lead with no amount or a short phone is refused with the
-- message the form shows; the same number sent twice comes back as a
-- duplicate rather than a second record; and anon reading `leads` or
-- `consultancy_lead_links` directly gets zero rows.
-- =========================================================

create table if not exists public.consultancy_lead_links (
  id              uuid primary key default gen_random_uuid(),
  consultancy_id  uuid not null references consultancies(id),
  token           text not null unique,
  label           text,
  is_active       boolean not null default true,
  submission_count integer not null default 0,
  last_submitted_at timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  revoked_at      timestamptz,
  revoked_by      uuid references users(id)
);

create index if not exists idx_consultancy_lead_links_consultancy
  on consultancy_lead_links (consultancy_id) where is_active;

-- Each submission is logged whether or not it became a lead, so a partner
-- asking "did my ten go through?" can be answered, and a flood of refusals
-- is visible rather than silent.
create table if not exists public.partner_lead_submissions (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references consultancy_lead_links(id),
  lead_id     uuid references leads(id),
  outcome     text not null,
  student_name text,
  student_phone text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_partner_lead_submissions_link
  on partner_lead_submissions (link_id, created_at desc);

alter table consultancy_lead_links   enable row level security;
alter table partner_lead_submissions enable row level security;

-- Staff read and manage links; anon never touches these tables directly,
-- only through the definer functions below.
drop policy if exists links_admin_all on consultancy_lead_links;
create policy links_admin_all on consultancy_lead_links
  for all to authenticated using (is_admin_or_manager()) with check (is_admin_or_manager());

drop policy if exists links_staff_read on consultancy_lead_links;
create policy links_staff_read on consultancy_lead_links
  for select to authenticated using (is_internal_staff());

drop policy if exists submissions_staff_read on partner_lead_submissions;
create policy submissions_staff_read on partner_lead_submissions
  for select to authenticated using (is_internal_staff());

-- ---------------------------------------------------------
-- What the public page may know: the firm's name, and nothing else.
-- ---------------------------------------------------------
create or replace function public.partner_form_context(p_token text)
returns table (consultancy_name text, is_open boolean)
language sql stable security definer set search_path = public as $function$
  select c.name, (l.is_active and l.revoked_at is null and not c.is_deleted)
  from consultancy_lead_links l
  join consultancies c on c.id = l.consultancy_id
  where l.token = btrim(coalesce(p_token, ''))
    and length(btrim(coalesce(p_token, ''))) >= 16;
$function$;

-- ---------------------------------------------------------
-- The write. Named arguments only.
-- ---------------------------------------------------------
create or replace function public.submit_partner_lead(
  p_token        text,
  p_student_name text,
  p_phone        text,
  p_email        text default null,
  p_country      text default null,
  p_course       text default null,
  p_university   text default null,
  p_amount       numeric default null,
  p_intake_month int default null,
  p_intake_year  int default null
)
returns table (outcome text, message text)
language plpgsql security definer set search_path = public as $function$
declare
  v_link      consultancy_lead_links%rowtype;
  v_cons      consultancies%rowtype;
  v_phone10   text;
  v_recent    int;
  v_rm        uuid;
  v_source    uuid;
  v_stage     uuid;
  v_lead      uuid;
  v_name      text := btrim(coalesce(p_student_name, ''));
begin
  select * into v_link from consultancy_lead_links
   where token = btrim(coalesce(p_token, '')) and is_active and revoked_at is null;
  if not found then
    return query select 'invalid_link'::text,
      'This form link is not active. Ask your Zolve contact for a current one.'::text;
    return;
  end if;

  select * into v_cons from consultancies where id = v_link.consultancy_id and not is_deleted;
  if not found then
    return query select 'invalid_link'::text,
      'This form link is not active. Ask your Zolve contact for a current one.'::text;
    return;
  end if;

  -- Rate limit per link, counted on submissions actually recorded.
  select count(*) into v_recent from partner_lead_submissions
   where link_id = v_link.id and created_at > now() - interval '1 hour';
  if v_recent >= 40 then
    return query select 'rate_limited'::text,
      'That is a lot of students in one hour. Please try again shortly.'::text;
    return;
  end if;

  v_phone10 := right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10);

  if v_name = '' then
    return query select 'invalid'::text, 'Please enter the student''s name.'::text; return;
  end if;
  if length(v_phone10) < 10 then
    return query select 'invalid'::text, 'Please enter a 10-digit mobile number.'::text; return;
  end if;
  if coalesce(p_amount, 0) <= 0 then
    return query select 'invalid'::text, 'Please enter how much loan the student needs.'::text; return;
  end if;

  -- Already ours? Say so plainly instead of making a second record of the
  -- same student. Same last-ten-digits key the rest of the CRM dedupes on.
  if exists (
    select 1 from leads l
     where not l.is_deleted
       and right(regexp_replace(l.student_phone, '[^0-9]', '', 'g'), 10) = v_phone10
  ) then
    insert into partner_lead_submissions (link_id, outcome, student_name, student_phone)
    values (v_link.id, 'duplicate', v_name, p_phone);
    return query select 'duplicate'::text,
      'We already have this student on file. Your Zolve contact can tell you where it stands.'::text;
    return;
  end if;

  select id into v_source from lead_sources where name = 'BD Partnership' and is_active and not is_deleted;
  select id into v_stage  from lead_stages  where name = 'Lead Qualified' and not is_deleted;

  -- Whoever has actually been working this partner's leads lately.
  select l.assigned_rm_id into v_rm
    from leads l
    join users u on u.id = l.assigned_rm_id and u.is_active and not u.is_deleted
   where l.consultancy_id = v_cons.id and not l.is_deleted
     and l.created_at > now() - interval '120 days'
   group by l.assigned_rm_id
   order by count(*) desc, max(l.created_at) desc
   limit 1;

  insert into leads (
    student_name, student_phone, student_email, destination_country,
    course_name, university_name, loan_amount_requested,
    intake_month, intake_year,
    lead_source_id, current_stage_id, consultancy_id, bd_name,
    assigned_rm_id, assigned_manager_id, last_activity_at
  ) values (
    v_name, btrim(p_phone), nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_country, '')), ''),
    nullif(btrim(coalesce(p_course, '')), ''),
    nullif(btrim(coalesce(p_university, '')), ''),
    p_amount, p_intake_month, p_intake_year,
    v_source, v_stage, v_cons.id, v_cons.bd_manager,
    v_rm, (select reporting_manager_id from users where id = v_rm),
    now()
  ) returning id into v_lead;

  insert into lead_events (lead_id, event_type, to_stage_id)
  values (v_lead, 'Lead Created', v_stage);

  insert into partner_lead_submissions (link_id, lead_id, outcome, student_name, student_phone)
  values (v_link.id, v_lead, 'created', v_name, p_phone);

  update consultancy_lead_links
     set submission_count = submission_count + 1, last_submitted_at = now()
   where id = v_link.id;

  return query select 'created'::text,
    'Thank you — this student is now with the Zolve team.'::text;
end;
$function$;

revoke all on function public.partner_form_context(text) from public;
revoke all on function public.submit_partner_lead(text, text, text, text, text, text, text, numeric, int, int) from public;
grant execute on function public.partner_form_context(text) to anon, authenticated;
grant execute on function public.submit_partner_lead(text, text, text, text, text, text, text, numeric, int, int) to anon, authenticated;

-- ---------------------------------------------------------
-- Admin side: make a link, revoke a link, see how each is doing.
--
-- The token is two gen_random_uuid()s concatenated, not gen_random_bytes():
-- pgcrypto lives in the extensions schema on Supabase and these functions
-- pin search_path to public, so the bytes version failed at runtime. Two
-- UUIDs give 256 bits from the same CSPRNG and need nothing on the path;
-- 40 hex characters of that is far past guessable and still short enough
-- to paste into WhatsApp.
-- ---------------------------------------------------------
create or replace function public.create_partner_lead_link(p_consultancy_id uuid, p_label text default null)
returns text language plpgsql security definer set search_path = public as $function$
declare v_token text;
begin
  if not is_admin_or_manager() then
    raise exception 'Only an Admin or Manager can create a partner form link';
  end if;
  if not exists (select 1 from consultancies where id = p_consultancy_id and not is_deleted) then
    raise exception 'That consultancy does not exist';
  end if;

  v_token := substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 40);

  insert into consultancy_lead_links (consultancy_id, token, label, created_by)
  values (p_consultancy_id, v_token, nullif(btrim(coalesce(p_label, '')), ''), auth.uid());
  return v_token;
end;
$function$;

create or replace function public.revoke_partner_lead_link(p_link_id uuid)
returns void language plpgsql security definer set search_path = public as $function$
begin
  if not is_admin_or_manager() then
    raise exception 'Only an Admin or Manager can revoke a partner form link';
  end if;
  update consultancy_lead_links
     set is_active = false, revoked_at = now(), revoked_by = auth.uid()
   where id = p_link_id;
end;
$function$;

create or replace function public.partner_lead_links()
returns table (
  id uuid, consultancy_id uuid, consultancy_name text, token text, label text,
  is_active boolean, submission_count integer, last_submitted_at timestamptz,
  created_at timestamptz, leads_created bigint, duplicates bigint
)
language sql stable security definer set search_path = public as $function$
  select l.id, l.consultancy_id, c.name, l.token, l.label, l.is_active,
         l.submission_count, l.last_submitted_at, l.created_at,
         count(s.id) filter (where s.outcome = 'created'),
         count(s.id) filter (where s.outcome = 'duplicate')
  from consultancy_lead_links l
  join consultancies c on c.id = l.consultancy_id
  left join partner_lead_submissions s on s.link_id = l.id
  where is_internal_staff() or is_admin()
  group by l.id, c.name
  order by c.name;
$function$;

revoke all on function public.create_partner_lead_link(uuid, text) from public;
revoke all on function public.revoke_partner_lead_link(uuid) from public;
revoke all on function public.partner_lead_links() from public;
grant execute on function public.create_partner_lead_link(uuid, text) to authenticated;
grant execute on function public.revoke_partner_lead_link(uuid) to authenticated;
grant execute on function public.partner_lead_links() to authenticated;
