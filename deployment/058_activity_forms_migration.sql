-- =========================================================
-- 058 — Custom activity forms
--
-- Build a form once ("Referral calling", "Document chase", "Win-back"),
-- give it whatever fields that campaign needs, then fill it against any
-- lead. Each submission is stored as an activity on that lead.
--
-- WHY VALUES ARE JSONB RATHER THAN A ROW PER ANSWER
--
-- The obvious alternative is an activity_values table with one row per
-- field per submission. It makes per-field reporting a plain join, but it
-- also means every read of one activity is a join and a pivot, and a form
-- with 12 fields writes 12 rows per call. Since the field definitions live
-- in activity_form_fields, the schema is known anyway — so the values ride
-- in one jsonb column keyed by field_key, with a GIN index so
-- `values @> '{"interested":"yes"}'` stays fast, and activity_form_export()
-- does the pivot for reporting. That keeps the common path (render a form,
-- save a submission, list a lead's activities) to single-row operations.
--
-- field_key is immutable once created and is what the jsonb is keyed by.
-- Labels can be renamed freely without orphaning historical answers — the
-- thing a "just rename the column" approach gets wrong.
-- =========================================================

-- ---------- Form definitions ----------
create table if not exists public.activity_forms (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  -- Shown on the button that opens the form, so a caller sees "Log referral
  -- call" rather than a generic label.
  action_label  text,
  icon          text,
  is_active     boolean not null default true,
  -- Optional targeting: empty array means "offer this form on every lead".
  -- Used to surface the right form rather than to restrict data — a manager
  -- can still fill any active form against any lead they can edit.
  target_source_ids uuid[] not null default '{}',
  target_stage_ids  uuid[] not null default '{}',
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.users(id),
  is_deleted    boolean not null default false
);

create index if not exists idx_activity_forms_active
  on public.activity_forms(sort_order, name) where is_deleted = false and is_active = true;

-- ---------- Field definitions ----------
create table if not exists public.activity_form_fields (
  id           uuid primary key default gen_random_uuid(),
  form_id      uuid not null references public.activity_forms(id) on delete cascade,
  -- Stable key into lead_activities.values. Never reused, never renamed.
  field_key    text not null check (field_key ~ '^[a-z][a-z0-9_]{0,48}$'),
  label        text not null,
  field_type   text not null check (field_type in
                 ('text','textarea','number','date','datetime','select',
                  'multiselect','checkbox','phone','email','rating')),
  -- Choices for select/multiselect, as a json array of strings.
  options      jsonb not null default '[]',
  is_required  boolean not null default false,
  help_text    text,
  placeholder  text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  is_deleted   boolean not null default false,
  unique (form_id, field_key),
  -- A choice field with no choices is a dead end in the UI; catch it here
  -- rather than at render time.
  constraint options_required_for_choice_fields check (
    field_type not in ('select','multiselect')
    or jsonb_array_length(options) > 0
  )
);

create index if not exists idx_activity_form_fields_form
  on public.activity_form_fields(form_id, sort_order) where is_deleted = false;

-- ---------- Submissions ----------
create table if not exists public.lead_activities (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  form_id       uuid not null references public.activity_forms(id),
  values        jsonb not null default '{}',
  -- Free-text summary shown in the lead timeline without opening the form.
  summary       text,
  performed_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  updated_at    timestamptz not null default now(),
  is_deleted    boolean not null default false
);

create index if not exists idx_lead_activities_lead
  on public.lead_activities(lead_id, performed_at desc) where is_deleted = false;
create index if not exists idx_lead_activities_form
  on public.lead_activities(form_id, performed_at desc) where is_deleted = false;
-- Makes containment queries over answers fast, which is what segmenting a
-- call list off a previous campaign's answers needs.
create index if not exists idx_lead_activities_values
  on public.lead_activities using gin (values);

-- ---------- RLS ----------
alter table public.activity_forms       enable row level security;
alter table public.activity_form_fields enable row level security;
alter table public.lead_activities      enable row level security;

drop policy if exists activity_forms_read on public.activity_forms;
create policy activity_forms_read on public.activity_forms
  for select to authenticated using ((select public.is_internal_staff()));

drop policy if exists activity_forms_write on public.activity_forms;
create policy activity_forms_write on public.activity_forms
  for all to authenticated
  using ((select public.is_admin_or_manager()))
  with check ((select public.is_admin_or_manager()));

drop policy if exists activity_form_fields_read on public.activity_form_fields;
create policy activity_form_fields_read on public.activity_form_fields
  for select to authenticated using ((select public.is_internal_staff()));

drop policy if exists activity_form_fields_write on public.activity_form_fields;
create policy activity_form_fields_write on public.activity_form_fields
  for all to authenticated
  using ((select public.is_admin_or_manager()))
  with check ((select public.is_admin_or_manager()));

-- Reading and writing an activity follows the lead it belongs to: if you can
-- see the lead you can see its activities, and an RM filling a form on their
-- own lead must not need edit rights on the lead record itself.
drop policy if exists lead_activities_read on public.lead_activities;
create policy lead_activities_read on public.lead_activities
  for select to authenticated using ((select public.can_view_lead(lead_id)));

drop policy if exists lead_activities_insert on public.lead_activities;
create policy lead_activities_insert on public.lead_activities
  for insert to authenticated with check ((select public.can_view_lead(lead_id)));

-- Correcting a submission is limited to its author, or a manager. Everyone
-- else's record of what was said on a call stays as written.
drop policy if exists lead_activities_update on public.lead_activities;
create policy lead_activities_update on public.lead_activities
  for update to authenticated
  using (created_by = auth.uid() or (select public.is_admin_or_manager()))
  with check (created_by = auth.uid() or (select public.is_admin_or_manager()));

-- ---------- Validation ----------
-- Required fields and choice values are checked in the database, not only in
-- the form UI. A submission that skipped the UI (import, integration, a stale
-- tab) would otherwise land silently incomplete.
create or replace function public.validate_activity_values()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  f record;
  v jsonb;
begin
  for f in
    select field_key, label, field_type, options, is_required
    from activity_form_fields
    where form_id = new.form_id and not is_deleted
  loop
    v := new.values -> f.field_key;

    if f.is_required and (v is null or v = 'null'::jsonb
                          or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '')
                          or (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0)) then
      raise exception '% is required.', f.label using errcode = '23514';
    end if;

    if v is null or v = 'null'::jsonb then continue; end if;

    if f.field_type = 'select' and jsonb_typeof(v) = 'string'
       and not (f.options ? (v #>> '{}')) then
      raise exception '% is not one of the choices for %.', v #>> '{}', f.label using errcode = '23514';
    end if;

    if f.field_type = 'multiselect' then
      if jsonb_typeof(v) <> 'array' then
        raise exception '% expects a list of choices.', f.label using errcode = '23514';
      end if;
      if exists (select 1 from jsonb_array_elements_text(v) x where not (f.options ? x)) then
        raise exception '% contains a choice that is not on the list.', f.label using errcode = '23514';
      end if;
    end if;

    if f.field_type = 'number' and jsonb_typeof(v) not in ('number','null') then
      raise exception '% must be a number.', f.label using errcode = '23514';
    end if;
  end loop;

  -- Keys that match no field are dropped rather than stored: they are almost
  -- always a renamed or deleted field, and keeping them makes every later
  -- export ambiguous.
  new.values := (
    select coalesce(jsonb_object_agg(k, val), '{}'::jsonb)
    from jsonb_each(new.values) as e(k, val)
    where exists (select 1 from activity_form_fields af
                  where af.form_id = new.form_id and af.field_key = e.k and not af.is_deleted)
  );

  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_validate_activity_values on public.lead_activities;
create trigger trg_validate_activity_values
  before insert or update on public.lead_activities
  for each row execute function public.validate_activity_values();

-- ---------- Reporting ----------
-- Pivots a form's submissions into one row per activity with the answers as
-- named columns, which is the shape a call list or an export wants.
create or replace function public.activity_form_export(
  p_form_id uuid,
  p_from    date default null,
  p_to      date default null
) returns table (
  activity_id  uuid,
  lead_id      uuid,
  student_name text,
  student_phone text,
  owner        text,
  stage        text,
  performed_at timestamptz,
  filled_by    text,
  summary      text,
  answers      jsonb
) language sql security invoker set search_path to 'public' stable
as $function$
  select a.id, l.id, l.student_name, l.student_phone,
         coalesce(u.full_name, 'Unassigned'), st.name,
         a.performed_at, coalesce(fb.full_name, '—'), a.summary,
         -- Answers re-keyed by label, so an export is readable without
         -- needing the field definitions alongside it.
         (select coalesce(jsonb_object_agg(af.label, a.values -> af.field_key), '{}'::jsonb)
            from activity_form_fields af
           where af.form_id = a.form_id and not af.is_deleted)
  from lead_activities a
  join leads l on l.id = a.lead_id and not l.is_deleted
  join lead_stages st on st.id = l.current_stage_id
  left join users u on u.id = l.assigned_rm_id
  left join users fb on fb.id = a.created_by
  where a.form_id = p_form_id and not a.is_deleted
    and (p_from is null or a.performed_at::date >= p_from)
    and (p_to   is null or a.performed_at::date <= p_to)
  order by a.performed_at desc;
$function$;

revoke all on function public.activity_form_export(uuid, date, date) from public, anon;
grant execute on function public.activity_form_export(uuid, date, date) to authenticated;

-- Per-field answer counts, for "how did the referral campaign go" without
-- pulling every row down to the client.
create or replace function public.activity_form_summary(p_form_id uuid)
returns table (field_key text, label text, field_type text, answer text, responses bigint)
language sql security invoker set search_path to 'public' stable
as $function$
  select af.field_key, af.label, af.field_type, x.answer, count(*)
  from lead_activities a
  join activity_form_fields af on af.form_id = a.form_id and not af.is_deleted
  cross join lateral (
    select case
      when jsonb_typeof(a.values -> af.field_key) = 'array'
        then (select string_agg(t, ', ') from jsonb_array_elements_text(a.values -> af.field_key) t)
      else a.values ->> af.field_key
    end as answer
  ) x
  where a.form_id = p_form_id and not a.is_deleted and x.answer is not null
    and af.field_type in ('select','multiselect','checkbox','rating')
  group by af.field_key, af.label, af.field_type, x.answer, af.sort_order
  order by af.sort_order, count(*) desc;
$function$;

revoke all on function public.activity_form_summary(uuid) from public, anon;
grant execute on function public.activity_form_summary(uuid) to authenticated;
