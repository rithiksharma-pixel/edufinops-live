-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- Adds the Lead x Lender status matrix (one row per lead per active
-- lender), the reasons lookup, auto-seed/backfill triggers, and the
-- share_lead_with_lender RPC that atomically creates the deal when a
-- row is marked Shared. Also fixes a discovered pre-existing bug:
-- internal staff (RM/Manager/Counselor) had no RLS permission to read
-- a Lender-role user's row at all, silently breaking the officer picker.

create table lead_lender_not_shared_reasons (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  is_deleted  boolean not null default false,
  status      text not null default 'active',
  unique (name)
);
create trigger trg_lead_lender_not_shared_reasons_updated_at
  before update on lead_lender_not_shared_reasons
  for each row execute function set_updated_at();

insert into lead_lender_not_shared_reasons (name) values
  ('Student already logged in with this lender'),
  ('Student not interested in this lender'),
  ('Profile doesn''t match lender criteria'),
  ('Waiting on documents before sharing'),
  ('Lender not accepting this course/destination currently'),
  ('Other');

create table lead_lender_status (
  id                    uuid primary key default gen_random_uuid(),
  lead_id               uuid not null references leads(id) on delete cascade,
  lender_id             uuid not null references lenders(id),
  share_status          text not null default 'Not Shared' check (share_status in ('Not Shared', 'Shared')),
  not_shared_reason_id  uuid references lead_lender_not_shared_reasons(id),
  not_shared_other_text text,
  deal_id               uuid references deals(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'active',
  unique (lead_id, lender_id)
);
create index idx_lead_lender_status_lead_id on lead_lender_status(lead_id);
create trigger trg_lead_lender_status_updated_at
  before update on lead_lender_status
  for each row execute function set_updated_at();

alter table lead_lender_status enable row level security;
alter table lead_lender_status force row level security;
create policy lead_lender_status_select on lead_lender_status
  for select using (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
  );
create policy lead_lender_status_update on lead_lender_status
  for update using (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
  ) with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
  );

alter table lead_lender_not_shared_reasons enable row level security;
alter table lead_lender_not_shared_reasons force row level security;
create policy lead_lender_not_shared_reasons_select on lead_lender_not_shared_reasons for select using (auth.uid() is not null);
create policy lead_lender_not_shared_reasons_insert on lead_lender_not_shared_reasons for insert with check (is_admin());
create policy lead_lender_not_shared_reasons_update on lead_lender_not_shared_reasons for update using (is_admin()) with check (is_admin());

create or replace function seed_lead_lender_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_lender_status (lead_id, lender_id, created_by, updated_by)
  select new.id, l.id, new.created_by, new.created_by
  from lenders l
  where l.is_active = true and l.is_deleted = false
  on conflict (lead_id, lender_id) do nothing;
  return new;
end;
$$;
create trigger trg_seed_lead_lender_status
  after insert on leads
  for each row execute function seed_lead_lender_status();

create or replace function backfill_lender_onto_leads()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = true and new.is_deleted = false and (tg_op = 'INSERT' or old.is_active = false) then
    insert into lead_lender_status (lead_id, lender_id, created_by, updated_by)
    select l.id, new.id, new.created_by, new.created_by
    from leads l
    where l.is_deleted = false
    on conflict (lead_id, lender_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger trg_backfill_lender_onto_leads
  after insert or update on lenders
  for each row execute function backfill_lender_onto_leads();

-- Backfill existing leads x existing lenders (one-time, for data that
-- predates this migration), and link already-shared deals in.
insert into lead_lender_status (lead_id, lender_id, created_by, updated_by)
select l.id, ln.id, null, null
from leads l
cross join lenders ln
where l.is_deleted = false and ln.is_active = true and ln.is_deleted = false
on conflict (lead_id, lender_id) do nothing;

update lead_lender_status lls
set share_status = 'Shared', deal_id = d.id
from deals d
where d.lead_id = lls.lead_id and d.lender_id = lls.lender_id and d.is_deleted = false
  and lls.share_status = 'Not Shared';

create policy users_select_lender_officers_for_internal_staff on users
  for select using (
    (is_admin() or is_manager() or is_rm() or is_counselor())
    and exists (select 1 from roles r where r.id = role_id and r.name = 'Lender')
  );

create or replace function share_lead_with_lender(
  p_lead_lender_status_id uuid,
  p_loan_officer_id uuid,
  p_remarks text default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_row lead_lender_status%rowtype;
  v_officer_org uuid;
  v_deal_id uuid;
  v_opening_stage_id uuid;
begin
  select * into v_row from lead_lender_status where id = p_lead_lender_status_id for update;
  if not found then
    raise exception 'Lender row % not found or not visible', p_lead_lender_status_id;
  end if;
  if v_row.share_status = 'Shared' then
    raise exception 'This lender is already marked Shared for this lead';
  end if;

  select lender_organization_id into v_officer_org from users where id = p_loan_officer_id;
  if v_officer_org is null or v_officer_org != v_row.lender_id then
    raise exception 'Selected officer does not belong to this lender';
  end if;

  select id into v_opening_stage_id from deal_stages where sequence_order = (select min(sequence_order) from deal_stages where is_deleted = false) and is_deleted = false;

  v_deal_id := gen_random_uuid();
  insert into deals (id, lead_id, lender_id, current_deal_stage_id, assigned_loan_officer_id, remarks, created_by, updated_by)
  values (v_deal_id, v_row.lead_id, v_row.lender_id, v_opening_stage_id, p_loan_officer_id, p_remarks, auth.uid(), auth.uid());

  insert into deal_bank_prospect_details (deal_id) values (v_deal_id) on conflict (deal_id) do nothing;

  update lead_lender_status
  set share_status = 'Shared', deal_id = v_deal_id, not_shared_reason_id = null, not_shared_other_text = null, updated_by = auth.uid()
  where id = p_lead_lender_status_id;

  return v_deal_id;
end;
$$;
