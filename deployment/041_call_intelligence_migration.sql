-- =========================================================
-- 041 — Tangent Intelligence, phase 1
--   call recording -> transcript -> summary -> field suggestions
--
-- WHY THIS EXISTS
-- ---------------
-- The fields that matter most to reporting are exactly the ones nobody types
-- after a call. Measured across 11,949 leads the day this shipped:
--     course_name            216   (1.8%)
--     university_name        225   (1.9%)
--     destination_country  1,652   (13.8%)
--     loan_amount_requested  419   (3.5%)
--     intake_month             0
--     intake_year              0
-- RMs hear all of it on every call. It just never reaches the CRM. That is
-- the funnel, the consultancy reports and lender matching all being broken at
-- the source. Extraction is the point of this feature; the summary is the
-- part people notice first.
--
-- THE ONE RULE
-- ------------
-- Extracted values NEVER write themselves onto the lead. They land in
-- call_field_suggestions and a human accepts each one, at which point
-- apply_call_suggestion() does a typed, validated write. An LLM quietly
-- rewriting university_name across the book is not a failure mode worth
-- risking, and the accept/reject record is the only honest per-field accuracy
-- signal available.
--
-- There is deliberately NO insert policy for end users on call_analyses or
-- call_field_suggestions. Only the Edge Function (service_role) writes them,
-- so nothing in the browser can fabricate a suggestion and then accept it.
--
-- SETUP — this does nothing until all three are done
--   supabase functions deploy analyze-call-recording --no-verify-jwt
--   supabase secrets set OPENAI_API_KEY=...        (transcription)
--   supabase secrets set ANTHROPIC_API_KEY=...     (analysis)
-- NOTIFICATION_SECRET and Vault's notification_secret already exist from the
-- email work and are reused here, so there is one secret to rotate, not two.
-- =========================================================

insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;

create table if not exists public.call_recordings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  lead_event_id uuid references public.lead_events(id),
  storage_path text not null,
  original_filename text,
  size_bytes bigint,
  duration_seconds integer,
  status text not null default 'pending',
  error_message text,
  uploaded_by uuid references public.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  is_deleted boolean not null default false,
  constraint call_recordings_status_check
    check (status in ('pending','processing','done','failed'))
);
create index if not exists call_recordings_lead_idx on public.call_recordings(lead_id);
create index if not exists call_recordings_status_idx on public.call_recordings(status);

create table if not exists public.call_analyses (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null unique references public.call_recordings(id) on delete cascade,
  lead_id uuid not null references public.leads(id),
  transcript text,
  detected_language text,
  summary text,
  next_actions jsonb default '[]'::jsonb,
  risk_flags jsonb default '[]'::jsonb,
  sentiment text,
  transcription_model text,
  analysis_model text,
  created_at timestamptz not null default now()
);
create index if not exists call_analyses_lead_idx on public.call_analyses(lead_id);

create table if not exists public.call_field_suggestions (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.call_recordings(id) on delete cascade,
  lead_id uuid not null references public.leads(id),
  field_name text not null,
  suggested_value text not null,
  confidence text,
  evidence text,
  status text not null default 'pending',
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint call_field_suggestions_status_check
    check (status in ('pending','accepted','rejected','superseded')),
  -- Only fields apply_call_suggestion() knows how to write. Anything else is
  -- refused at insert rather than discovered at apply time.
  constraint call_field_suggestions_field_check
    check (field_name in ('course_name','university_name','destination_country',
                          'intake_month','intake_year','loan_amount_requested',
                          'admission_offer_status','loan_type'))
);
create index if not exists call_field_suggestions_lead_idx
  on public.call_field_suggestions(lead_id, status);

alter table public.call_recordings enable row level security;
alter table public.call_analyses enable row level security;
alter table public.call_field_suggestions enable row level security;

drop policy if exists call_recordings_select on public.call_recordings;
create policy call_recordings_select on public.call_recordings for select
  using (can_view_lead(lead_id));
drop policy if exists call_recordings_insert on public.call_recordings;
create policy call_recordings_insert on public.call_recordings for insert
  with check (can_view_lead(lead_id));
drop policy if exists call_recordings_update on public.call_recordings;
create policy call_recordings_update on public.call_recordings for update
  using (can_view_lead(lead_id));

drop policy if exists call_analyses_select on public.call_analyses;
create policy call_analyses_select on public.call_analyses for select
  using (can_view_lead(lead_id));

drop policy if exists call_field_suggestions_select on public.call_field_suggestions;
create policy call_field_suggestions_select on public.call_field_suggestions for select
  using (can_view_lead(lead_id));
drop policy if exists call_field_suggestions_update on public.call_field_suggestions;
create policy call_field_suggestions_update on public.call_field_suggestions for update
  using (can_view_lead(lead_id));

-- Object path is <lead_id>/<file>, so folder[1] is the lead it belongs to.
drop policy if exists call_recordings_read on storage.objects;
create policy call_recordings_read on storage.objects for select
  using (bucket_id = 'call-recordings'
         and can_view_lead(((storage.foldername(name))[1])::uuid));
drop policy if exists call_recordings_write on storage.objects;
create policy call_recordings_write on storage.objects for insert
  with check (bucket_id = 'call-recordings'
         and can_view_lead(((storage.foldername(name))[1])::uuid));

-- Dispatch, mirroring notify_via_email: pg_net carries no user JWT, so a
-- Vault shared secret is the auth.
create or replace function public.dispatch_call_analysis()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'notification_secret';
  if v_secret is null then
    raise warning 'notification_secret not in Vault; call recording % left pending', new.id;
    return new;
  end if;
  perform net.http_post(
    url := 'https://wgzgqbfankdbqxxcesci.supabase.co/functions/v1/analyze-call-recording',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notification-secret', v_secret
    ),
    body := jsonb_build_object('recording_id', new.id)
  );
  return new;
end;
$function$;

drop trigger if exists trg_dispatch_call_analysis on public.call_recordings;
create trigger trg_dispatch_call_analysis
  after insert on public.call_recordings
  for each row when (new.status = 'pending')
  execute function public.dispatch_call_analysis();

-- Typed per field, so a model returning "Fall" for intake_month fails loudly
-- instead of silently writing null. SECURITY INVOKER: the caller must already
-- be able to update the lead. Lead stage is untouched, so the Admin-only
-- stage guard is unaffected.
create or replace function public.apply_call_suggestion(p_suggestion_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  s record;
  v_num numeric;
  v_int integer;
begin
  select * into s from call_field_suggestions where id = p_suggestion_id;
  if not found then
    raise exception 'Suggestion not found';
  end if;
  if s.status <> 'pending' then
    raise exception 'Suggestion already %', s.status;
  end if;

  if s.field_name in ('course_name','university_name','destination_country',
                      'admission_offer_status','loan_type') then
    execute format('update leads set %I = $1, updated_at = now() where id = $2', s.field_name)
      using btrim(s.suggested_value), s.lead_id;

  elsif s.field_name in ('intake_month','intake_year') then
    begin
      v_int := btrim(s.suggested_value)::integer;
    exception when others then
      raise exception '% must be a whole number, got "%"', s.field_name, s.suggested_value;
    end;
    if s.field_name = 'intake_month' and (v_int < 1 or v_int > 12) then
      raise exception 'intake_month must be 1-12, got %', v_int;
    end if;
    if s.field_name = 'intake_year' and (v_int < 2000 or v_int > 2100) then
      raise exception 'intake_year out of range: %', v_int;
    end if;
    execute format('update leads set %I = $1, updated_at = now() where id = $2', s.field_name)
      using v_int, s.lead_id;

  elsif s.field_name = 'loan_amount_requested' then
    begin
      v_num := btrim(s.suggested_value)::numeric;
    exception when others then
      raise exception 'loan_amount_requested must be numeric, got "%"', s.suggested_value;
    end;
    if v_num <= 0 then
      raise exception 'loan_amount_requested must be positive, got %', v_num;
    end if;
    update leads set loan_amount_requested = v_num, updated_at = now() where id = s.lead_id;

  else
    raise exception 'No apply rule for field %', s.field_name;
  end if;

  update call_field_suggestions
     set status = 'accepted', decided_by = auth.uid(), decided_at = now()
   where id = p_suggestion_id;

  -- Same pattern as every other write here: the change and its timeline entry
  -- land together, so history cannot drift from state.
  insert into lead_events (lead_id, event_type, remarks, created_by)
  values (s.lead_id, 'Note',
          format('Tangent Intelligence: %s set to "%s" from a call recording',
                 s.field_name, btrim(s.suggested_value)),
          auth.uid());
end;
$function$;
