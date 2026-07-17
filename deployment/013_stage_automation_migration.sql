-- Run this once on an EXISTING project that predates this file.
-- =========================================================
-- Lead stages become a short, EVENT-DRIVEN pipeline instead of a long
-- manually-clicked list. The eight stages are:
--   Lead Qualified → App Start → Bank Prospect → Login → Sanction →
--   PF Paid → Disbursement, plus Lead Lost (manual, terminal).
--
-- A lead's stage is computed, not picked, by recompute_lead_stage():
--   • created                          → Lead Qualified
--   • an "Interested" call logged      → App Start
--   • any document uploaded            → Bank Prospect
--   • from Bank Prospect on, it follows the FURTHEST live lender deal
--     (Login/Sanction/PF/Disbursement), because that's where the real
--     progress lives. Per-bank figures (ROI, sanction amount, login id…)
--     stay on each deal; the lead only mirrors the furthest stage name.
-- Lead Lost is the one manual override (mark_lead_lost), with a reason.
-- =========================================================

-- ---------- 1. New columns ----------
alter table leads add column if not exists lost_reason_id uuid;
alter table leads add column if not exists lost_remarks text;
alter table deal_login_details add column if not exists login_id text;

-- ---------- 2. Lead Lost reasons (seeded, admin-editable) ----------
create table if not exists lead_lost_reasons (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  sequence_order integer not null default 100,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  updated_by     uuid references users(id),
  is_deleted     boolean not null default false,
  status         text not null default 'active'
);

alter table leads
  drop constraint if exists leads_lost_reason_id_fkey,
  add constraint leads_lost_reason_id_fkey
    foreign key (lost_reason_id) references lead_lost_reasons(id);

alter table lead_lost_reasons enable row level security;
drop policy if exists lead_lost_reasons_select on lead_lost_reasons;
drop policy if exists lead_lost_reasons_write on lead_lost_reasons;
create policy lead_lost_reasons_select on lead_lost_reasons for select using (auth.uid() is not null);
create policy lead_lost_reasons_write  on lead_lost_reasons for all using (coalesce(is_admin(), false)) with check (coalesce(is_admin(), false));

insert into lead_lost_reasons (name, sequence_order) values
  ('Not eligible',          10),
  ('Chose another lender',  20),
  ('Self / family funded',  30),
  ('Course / plan dropped', 40),
  ('Unresponsive',          50),
  ('Budget / ROI too high', 60),
  ('Other',                 900)
on conflict (name) do nothing;

-- ---------- 3. Reshape lead_stages: 12 old → 8 new ----------
-- Reuse the existing "PF Paid" row (name already matches); insert the
-- seven genuinely-new stages; then remap every lead + lead_event off the
-- retired stages and soft-delete them.
update lead_stages set sequence_order = 60, is_terminal = false, is_deleted = false where name = 'PF Paid';

insert into lead_stages (name, sequence_order, is_terminal) values
  ('Lead Qualified', 10,  false),
  ('App Start',      20,  false),
  ('Bank Prospect',  30,  false),
  ('Login',          40,  false),
  ('Sanction',       50,  false),
  ('Disbursement',   70,  false),
  ('Lead Lost',      900, true)
on conflict (name) do update set sequence_order = excluded.sequence_order, is_terminal = excluded.is_terminal, is_deleted = false;

-- old name → new name
create temporary table _stage_remap (old_name text, new_name text) on commit drop;
insert into _stage_remap values
  ('Lead Created',        'Lead Qualified'),
  ('Contacted',           'Lead Qualified'),
  ('Connected',           'Lead Qualified'),
  ('Interested',          'App Start'),
  ('Documents Requested', 'Bank Prospect'),
  ('Documents Received',  'Bank Prospect'),
  ('Shared With Lender',  'Bank Prospect'),
  ('Sanctioned',          'Sanction'),
  ('Disbursed',           'Disbursement'),
  ('Dropped',             'Lead Lost'),
  ('Lost',                'Lead Lost');

update leads l set current_stage_id = ns.id
from _stage_remap m
  join lead_stages os on os.name = m.old_name
  join lead_stages ns on ns.name = m.new_name
where l.current_stage_id = os.id;

update lead_events e set to_stage_id = ns.id
from _stage_remap m
  join lead_stages os on os.name = m.old_name
  join lead_stages ns on ns.name = m.new_name
where e.to_stage_id = os.id;

update lead_events e set from_stage_id = ns.id
from _stage_remap m
  join lead_stages os on os.name = m.old_name
  join lead_stages ns on ns.name = m.new_name
where e.from_stage_id = os.id;

update lead_stages set is_deleted = true
where name in ('Lead Created','Contacted','Connected','Interested','Documents Requested','Documents Received','Shared With Lender','Sanctioned','Disbursed','Dropped','Lost');

-- ---------- 4. recompute_lead_stage() ----------
create or replace function public.recompute_lead_stage(p_lead_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_current_stage_id uuid;
  v_current_name text;
  v_lost_reason uuid;
  v_target_seq int := 10;               -- Lead Qualified floor
  v_deal_seq int;
  v_new_stage_id uuid;
begin
  select l.current_stage_id, s.name, l.lost_reason_id
    into v_current_stage_id, v_current_name, v_lost_reason
  from leads l left join lead_stages s on s.id = l.current_stage_id
  where l.id = p_lead_id;
  if not found then return; end if;

  -- Lead Lost is a manual terminal state; never auto-move it.
  if v_lost_reason is not null or v_current_name = 'Lead Lost' then return; end if;

  -- App Start: at least one "Interested" call logged.
  if exists (select 1 from lead_events e where e.lead_id = p_lead_id and e.event_type = 'Interested' and e.is_deleted = false) then
    v_target_seq := greatest(v_target_seq, 20);
  end if;

  -- Bank Prospect: any document uploaded.
  if exists (select 1 from documents d where d.lead_id = p_lead_id and d.is_deleted = false) then
    v_target_seq := greatest(v_target_seq, 30);
  end if;

  -- From Bank Prospect on: the furthest live deal, mapped to a lead stage.
  select max(case ds.name
      when 'Bank Prospect' then 30
      when 'Login'         then 40
      when 'Sanction'      then 50
      when 'PF'            then 60
      when 'Disbursement'  then 70
      when 'Closed Won'    then 70
      else 30 end)
    into v_deal_seq
  from deals dl join deal_stages ds on ds.id = dl.current_deal_stage_id
  where dl.lead_id = p_lead_id and dl.is_deleted = false and dl.is_rejected = false;
  if v_deal_seq is not null then v_target_seq := greatest(v_target_seq, v_deal_seq); end if;

  select id into v_new_stage_id from lead_stages where sequence_order = v_target_seq and is_deleted = false limit 1;
  if v_new_stage_id is null or v_new_stage_id = v_current_stage_id then return; end if;

  update leads set current_stage_id = v_new_stage_id, updated_at = now() where id = p_lead_id;
  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_current_stage_id, v_new_stage_id, 'Auto-updated from activity', auth.uid());
end;
$function$;

-- ---------- 5. Triggers that drive the automation ----------
create or replace function public.trg_recompute_from_document() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin perform recompute_lead_stage(new.lead_id); return new; end; $function$;

create or replace function public.trg_recompute_from_lead_event() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  -- Only interested-calls advance the stage; the 'Stage Changed' rows
  -- recompute writes are ignored here, so there's no recursion.
  if new.event_type = 'Interested' then perform recompute_lead_stage(new.lead_id); end if;
  return new;
end; $function$;

create or replace function public.trg_recompute_from_deal() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin perform recompute_lead_stage(new.lead_id); return new; end; $function$;

drop trigger if exists recompute_lead_stage_on_document on documents;
create trigger recompute_lead_stage_on_document after insert on documents
  for each row execute function trg_recompute_from_document();

drop trigger if exists recompute_lead_stage_on_event on lead_events;
create trigger recompute_lead_stage_on_event after insert on lead_events
  for each row execute function trg_recompute_from_lead_event();

drop trigger if exists recompute_lead_stage_on_deal on deals;
create trigger recompute_lead_stage_on_deal after insert or update of current_deal_stage_id, is_rejected, is_deleted on deals
  for each row execute function trg_recompute_from_deal();

-- ---------- 6. Manual Lead Lost / reopen ----------
create or replace function public.can_edit_lead(p_lead_id uuid) returns boolean
 language sql stable security definer set search_path to 'public' as $function$
  select coalesce(is_admin(), false) or exists (
    select 1 from leads l
    where l.id = p_lead_id and (
      l.assigned_rm_id = auth.uid()
      or l.assigned_manager_id = auth.uid()
      or rm_reports_to_current_manager(l.assigned_rm_id)
    )
  );
$function$;

create or replace function public.mark_lead_lost(p_lead_id uuid, p_reason_id uuid, p_remarks text default null)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_lost_id uuid; v_old uuid;
begin
  if not coalesce(can_edit_lead(p_lead_id), false) then raise exception 'Not allowed to update this lead'; end if;
  select id into v_lost_id from lead_stages where name = 'Lead Lost' and is_deleted = false;
  select current_stage_id into v_old from leads where id = p_lead_id;
  update leads set current_stage_id = v_lost_id, lost_reason_id = p_reason_id,
    lost_remarks = nullif(btrim(p_remarks), ''), updated_at = now() where id = p_lead_id;
  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Lead Lost', v_old, v_lost_id,
    (select name from lead_lost_reasons where id = p_reason_id) || coalesce(' — ' || nullif(btrim(p_remarks),''), ''),
    auth.uid());
end; $function$;

create or replace function public.reopen_lead(p_lead_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if not coalesce(can_edit_lead(p_lead_id), false) then raise exception 'Not allowed to update this lead'; end if;
  update leads set lost_reason_id = null, lost_remarks = null, updated_at = now() where id = p_lead_id;
  insert into lead_events (lead_id, event_type, remarks, created_by)
  values (p_lead_id, 'Reopened', 'Lead reopened', auth.uid());
  perform recompute_lead_stage(p_lead_id);
end; $function$;
