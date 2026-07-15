-- =========================================================
-- MASTER MIGRATION — run this entire file once, in a fresh Supabase
-- project's SQL Editor, to stand up the whole platform: Lead
-- Management (+ Document Management), Authentication, Consultant
-- Portal, RM Workspace, Manager Dashboard, Lender Pipeline (+ bank
-- profile self-service).
--
-- Straight concatenation of the per-app migration files, in the exact
-- order verified to run clean against a real Postgres instance.
-- =========================================================

-- =========================================================
-- SOURCE: lead-management/sql/001_schema.sql
-- =========================================================
-- =========================================================
-- LEAD MANAGEMENT APPLICATION — CORE SCHEMA (REV 2)
-- =========================================================
-- REV 2 changes from the original build:
--   * lender_applications -> deals (matches the business's own terminology)
--   * lender_application_events -> deal_events
--   * Deal progress is now modeled as deal_stages x deal_stage_statuses,
--     matching the "Deal Stage Flow" reference diagram, instead of a
--     single flat application_status enum.
--   * On Hold / Rejected are modeled as orthogonal overlay states on the
--     deal (they can happen from ANY stage), not as values inside a
--     per-stage status list — matching the diagram's "Any Stage" boxes.
--   * Stage-specific captured fields moved into their own child tables
--     (deal_bank_prospect_details, deal_login_details, deal_sanction_details,
--     deal_pf_details) instead of one wide, mostly-null deals table.
--   * `roles` is no longer constrained to a fixed list — Admin can add
--     roles (e.g. "Counselor") without a schema migration.
--
-- NOTE: Application (Lead) stage auto-derivation from "highest active
-- deal stage across lenders", and the 4-stage App Not Started/Started/
-- In Progress/Completed rollup, are OUT OF SCOPE for this revision per
-- explicit instruction — lead_stages/leads are untouched below.
-- =========================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =========================================================
-- ROLES (stub — Authentication app owns long-term)
-- No longer a fixed CHECK list: an Admin can add a new role
-- (e.g. "Counselor") without a code deploy.
-- =========================================================
create table roles (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid,
  is_deleted    boolean not null default false,
  status        text not null default 'active'
);

create trigger trg_roles_updated_at
  before update on roles
  for each row execute function set_updated_at();

-- =========================================================
-- USERS (stub — Authentication app owns long-term)
-- =========================================================
create table users (
  id                    uuid primary key references auth.users(id) on delete cascade,
  role_id               uuid not null references roles(id),
  full_name             text not null,
  email                 text not null unique,
  phone                 text,
  reporting_manager_id  uuid references users(id),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'active'
);

create index idx_users_role_id on users(role_id);
create index idx_users_reporting_manager_id on users(reporting_manager_id);

create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- =========================================================
-- LEAD SOURCES (configurable lookup) — unchanged
-- =========================================================
create table lead_sources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  category      text not null
                  check (category in ('Consultant','Business Development','Direct','Referral','Campaign')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users(id),
  updated_by    uuid references users(id),
  is_deleted    boolean not null default false,
  status        text not null default 'active'
);

create trigger trg_lead_sources_updated_at
  before update on lead_sources
  for each row execute function set_updated_at();

-- =========================================================
-- LEAD STAGES (Application/Lead level — unchanged, untouched
-- per this revision's scope)
-- =========================================================
create table lead_stages (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  sequence_order  integer not null,
  is_terminal     boolean not null default false,
  color           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_lead_stages_sequence on lead_stages(sequence_order);

create trigger trg_lead_stages_updated_at
  before update on lead_stages
  for each row execute function set_updated_at();

-- =========================================================
-- LEADS — unchanged from REV 1
-- =========================================================
create table leads (
  id                        uuid primary key default gen_random_uuid(),
  student_name              text not null,
  student_phone             text not null,
  student_email             text,
  student_dob               date,
  course_name               text,
  university_name           text,
  destination_country       text,
  intake_month              integer check (intake_month between 1 and 12),
  intake_year               integer,
  loan_amount_requested     numeric(14,2),
  currency                  text not null default 'INR',
  lead_source_id            uuid not null references lead_sources(id),
  source_user_id            uuid references users(id),
  current_stage_id          uuid not null references lead_stages(id),
  assigned_rm_id            uuid references users(id),
  assigned_manager_id       uuid references users(id),
  priority                  text not null default 'Normal'
                              check (priority in ('Low','Normal','High','Urgent')),
  next_follow_up_at         timestamptz,
  last_activity_at          timestamptz,
  is_duplicate_flag         boolean not null default false,
  duplicate_of_lead_id      uuid references leads(id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                 uuid references users(id),
  updated_by                 uuid references users(id),
  is_deleted                 boolean not null default false,
  status                     text not null default 'active'
);

create index idx_leads_assigned_rm_id on leads(assigned_rm_id);
create index idx_leads_current_stage_id on leads(current_stage_id);
create index idx_leads_next_follow_up_at on leads(next_follow_up_at);
create index idx_leads_student_phone on leads(student_phone);
create index idx_leads_source_user_id on leads(source_user_id);
create index idx_leads_is_deleted on leads(is_deleted);

create trigger trg_leads_updated_at
  before update on leads
  for each row execute function set_updated_at();

-- =========================================================
-- CO-APPLICANTS — unchanged
-- =========================================================
create table co_applicants (
  id                        uuid primary key default gen_random_uuid(),
  lead_id                   uuid not null references leads(id) on delete cascade,
  full_name                 text not null,
  relationship_to_student   text not null
                               check (relationship_to_student in ('Father','Mother','Guardian','Sibling','Spouse','Other')),
  phone                     text,
  email                     text,
  pan_number                text,
  annual_income              numeric(14,2),
  employment_type            text check (employment_type in ('Salaried','Self-Employed','Business','Retired','Other')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references users(id),
  updated_by                uuid references users(id),
  is_deleted                boolean not null default false,
  status                    text not null default 'active'
);

create index idx_co_applicants_lead_id on co_applicants(lead_id);

create trigger trg_co_applicants_updated_at
  before update on co_applicants
  for each row execute function set_updated_at();

-- =========================================================
-- LEAD ASSIGNMENTS — unchanged
-- =========================================================
create table lead_assignments (
  id                    uuid primary key default gen_random_uuid(),
  lead_id               uuid not null references leads(id) on delete cascade,
  assigned_to_user_id   uuid not null references users(id),
  assigned_by_user_id   uuid references users(id),
  assigned_at           timestamptz not null default now(),
  unassigned_at         timestamptz,
  reason                text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'active'
);

create index idx_lead_assignments_lead_id on lead_assignments(lead_id);
create index idx_lead_assignments_assigned_to on lead_assignments(assigned_to_user_id);

create trigger trg_lead_assignments_updated_at
  before update on lead_assignments
  for each row execute function set_updated_at();

-- =========================================================
-- LEAD EVENTS — unchanged
-- =========================================================
create table lead_events (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads(id) on delete cascade,
  event_type      text not null,
  from_stage_id   uuid references lead_stages(id),
  to_stage_id     uuid references lead_stages(id),
  remarks         text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_lead_events_lead_id_created_at on lead_events(lead_id, created_at desc);

-- =========================================================
-- LENDERS — master data, unchanged
-- =========================================================
create table lenders (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  code          text not null unique,
  contact_info  jsonb default '{}'::jsonb,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users(id),
  updated_by    uuid references users(id),
  is_deleted    boolean not null default false,
  status        text not null default 'active'
);

create trigger trg_lenders_updated_at
  before update on lenders
  for each row execute function set_updated_at();

-- =========================================================
-- DEAL STAGES (configurable, ordered — mirrors lead_stages pattern)
-- =========================================================
create table deal_stages (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  sequence_order  integer not null,
  is_terminal     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_deal_stages_sequence on deal_stages(sequence_order);

create trigger trg_deal_stages_updated_at
  before update on deal_stages
  for each row execute function set_updated_at();

-- =========================================================
-- DEAL STAGE STATUSES — the "positive path" sub-status within a
-- stage (e.g. Login Pending / Login Done). On Hold and Rejected are
-- deliberately NOT here — they're orthogonal overlay states on the
-- deal itself (see deals.is_on_hold / is_rejected below), because the
-- diagram treats them as "Any Stage" states, not per-stage values.
-- =========================================================
create table deal_stage_statuses (
  id              uuid primary key default gen_random_uuid(),
  deal_stage_id   uuid not null references deal_stages(id),
  name            text not null,
  sequence_order  integer not null,
  is_terminal_for_stage boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active',
  unique (deal_stage_id, name)
);

create index idx_deal_stage_statuses_stage_id on deal_stage_statuses(deal_stage_id);

create trigger trg_deal_stage_statuses_updated_at
  before update on deal_stage_statuses
  for each row execute function set_updated_at();

-- =========================================================
-- DEAL REJECTION REASONS / HOLD REASONS — configurable lookups
-- =========================================================
create table deal_rejection_reasons (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users(id),
  updated_by    uuid references users(id),
  is_deleted    boolean not null default false,
  status        text not null default 'active'
);

create trigger trg_deal_rejection_reasons_updated_at
  before update on deal_rejection_reasons
  for each row execute function set_updated_at();

create table deal_hold_reasons (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users(id),
  updated_by    uuid references users(id),
  is_deleted    boolean not null default false,
  status        text not null default 'active'
);

create trigger trg_deal_hold_reasons_updated_at
  before update on deal_hold_reasons
  for each row execute function set_updated_at();

-- =========================================================
-- DEALS (formerly lender_applications) — one row per lead-per-lender.
-- Common fields only; stage-specific fields live in the child tables
-- below. On Hold / Rejected are overlay flags, not stage values.
-- =========================================================
create table deals (
  id                        uuid primary key default gen_random_uuid(),
  lead_id                   uuid not null references leads(id) on delete cascade,
  lender_id                 uuid not null references lenders(id),

  current_deal_stage_id     uuid not null references deal_stages(id),
  current_stage_status_id   uuid references deal_stage_statuses(id),

  -- Internal sales team member handling this specific deal (role: Counselor)
  assigned_counselor_id     uuid references users(id),

  -- Lender-side people. Both will become real logins under the future
  -- Lender application — modeled as user references now (role: Lender),
  -- same "provisional but stable" approach we used for users/roles.
  assigned_loan_officer_id  uuid references users(id),

  remarks                   text,

  -- Overlay: On Hold (Any Stage)
  is_on_hold                boolean not null default false,
  hold_date                 timestamptz,
  hold_reason_id            uuid references deal_hold_reasons(id),
  hold_remarks              text,

  -- Overlay: Rejected (Any Stage)
  is_rejected               boolean not null default false,
  rejection_date            timestamptz,
  rejection_stage_id        uuid references deal_stages(id), -- stage the deal was AT when rejected
  rejection_reason_id       uuid references deal_rejection_reasons(id),
  rejection_remarks         text,

  -- Cached summary fields, populated when the deal reaches Closed Won
  -- (source of truth is still the disbursements table — these are a
  -- fast-read cache for list views/reporting, not the ledger itself)
  total_disbursed_amount    numeric(14,2),
  final_disbursement_date   date,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references users(id),
  updated_by                uuid references users(id),
  is_deleted                boolean not null default false,
  status                    text not null default 'active',

  unique (lead_id, lender_id)
);

create index idx_deals_lead_id on deals(lead_id);
create index idx_deals_lender_id on deals(lender_id);
create index idx_deals_current_stage_id on deals(current_deal_stage_id);
create index idx_deals_is_on_hold on deals(is_on_hold) where is_on_hold = true;
create index idx_deals_is_rejected on deals(is_rejected) where is_rejected = true;

create trigger trg_deals_updated_at
  before update on deals
  for each row execute function set_updated_at();

-- =========================================================
-- STAGE-SPECIFIC DETAIL TABLES
-- One row per deal per stage, created the first time the deal enters
-- that stage. Kept 1:1 with deals (unique deal_id) rather than folding
-- into one wide table, since each stage's fields are genuinely distinct.
-- =========================================================

create table deal_bank_prospect_details (
  deal_id             uuid primary key references deals(id) on delete cascade,
  region_shared_date  date,
  sm_shared_date      date,
  rm_shared_date      date,
  bank_rm_id          uuid references users(id), -- the LENDER's own RM (role: Lender), not our internal RM
  eligibility_status  text,
  remarks             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users(id),
  updated_by          uuid references users(id),
  is_deleted          boolean not null default false,
  status              text not null default 'active'
);

create trigger trg_deal_bank_prospect_details_updated_at
  before update on deal_bank_prospect_details
  for each row execute function set_updated_at();

create table deal_login_details (
  deal_id                 uuid primary key references deals(id) on delete cascade,
  loan_required_amount    numeric(14,2),
  login_amount            numeric(14,2),
  login_date              date,
  probable_sanction_date  date,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references users(id),
  updated_by              uuid references users(id),
  is_deleted              boolean not null default false,
  status                  text not null default 'active'
);

create trigger trg_deal_login_details_updated_at
  before update on deal_login_details
  for each row execute function set_updated_at();

create table deal_sanction_details (
  deal_id             uuid primary key references deals(id) on delete cascade,
  sanction_amount     numeric(14,2),
  sanction_date       date,
  probable_pf_date    date,
  interest_rate       numeric(5,2),
  tenure_months       integer,
  moratorium_months   integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users(id),
  updated_by          uuid references users(id),
  is_deleted          boolean not null default false,
  status              text not null default 'active'
);

create trigger trg_deal_sanction_details_updated_at
  before update on deal_sanction_details
  for each row execute function set_updated_at();

create table deal_pf_details (
  deal_id                   uuid primary key references deals(id) on delete cascade,
  pf_amount                 numeric(14,2),
  pf_date                   date,
  probable_disbursement_date date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references users(id),
  updated_by                uuid references users(id),
  is_deleted                boolean not null default false,
  status                    text not null default 'active'
);

create trigger trg_deal_pf_details_updated_at
  before update on deal_pf_details
  for each row execute function set_updated_at();

-- =========================================================
-- DEAL EVENTS (formerly lender_application_events) — append-only
-- timeline per deal. Immutable: no UPDATE/DELETE policy will exist.
-- =========================================================
create table deal_events (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals(id) on delete cascade,
  event_type      text not null,
  from_stage_id   uuid references deal_stages(id),
  to_stage_id     uuid references deal_stages(id),
  remarks         text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_deal_events_deal_id_created_at on deal_events(deal_id, created_at desc);

-- =========================================================
-- DISBURSEMENTS — multi-tranche, child of deals (renamed FK column)
-- =========================================================
create table disbursements (
  id                    uuid primary key default gen_random_uuid(),
  deal_id               uuid not null references deals(id) on delete cascade,
  tranche_number        integer not null,
  amount                numeric(14,2) not null,
  disbursed_date        date not null,
  academic_term         text,
  remarks               text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'active',
  unique (deal_id, tranche_number)
);

create index idx_disbursements_deal_id on disbursements(deal_id);

create trigger trg_disbursements_updated_at
  before update on disbursements
  for each row execute function set_updated_at();


-- =========================================================
-- SOURCE: lead-management/sql/002_rls_policies.sql
-- =========================================================
-- =========================================================
-- ROW LEVEL SECURITY — LEAD MANAGEMENT (REV 2)
-- =========================================================

create or replace function auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.name
  from users u
  join roles r on r.id = u.role_id
  where u.id = auth.uid()
    and u.is_deleted = false
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Admin' $$;

create or replace function is_manager()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Manager' $$;

create or replace function is_rm()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Relationship Manager' $$;

create or replace function is_source_role()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() in ('Consultant','Business Development') $$;

create or replace function is_counselor()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Counselor' $$;

create or replace function is_lender_side()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Lender' $$;

create or replace function rm_reports_to_current_manager(rm_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from users u
    where u.id = rm_user_id
      and u.reporting_manager_id = auth.uid()
  )
$$;

-- Whether the current user can see the given LEAD via any path
-- (used to cascade visibility into deal-related tables)
create or replace function can_view_lead(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from leads l
    where l.id = p_lead_id
      and (
        is_admin()
        or (is_manager() and (l.assigned_manager_id = auth.uid() or rm_reports_to_current_manager(l.assigned_rm_id)))
        or (is_rm() and l.assigned_rm_id = auth.uid())
        or (is_source_role() and l.source_user_id = auth.uid())
      )
  )
$$;

-- Whether the current user can see the given DEAL via any path
create or replace function can_view_deal(p_deal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from deals d
    where d.id = p_deal_id
      and (
        is_admin()
        or (is_manager() and can_view_lead(d.lead_id))
        or (is_rm() and can_view_lead(d.lead_id))
        or (is_counselor() and d.assigned_counselor_id = auth.uid())
        or (is_lender_side() and d.assigned_loan_officer_id = auth.uid())
        or (is_lender_side() and exists (
              select 1 from deal_bank_prospect_details bpd
              where bpd.deal_id = d.id and bpd.bank_rm_id = auth.uid()
            ))
      )
  )
$$;

-- ---------------------------------------------------------
-- Enable + force RLS on every table
-- ---------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'roles','users','lead_sources','lead_stages','leads','co_applicants',
    'lead_assignments','lead_events','lenders','deal_stages','deal_stage_statuses',
    'deal_rejection_reasons','deal_hold_reasons','deals','deal_bank_prospect_details',
    'deal_login_details','deal_sanction_details','deal_pf_details','deal_events','disbursements'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- =========================================================
-- ROLES / LEAD_SOURCES / LEAD_STAGES / LENDERS — unchanged
-- =========================================================
create policy roles_select_all on roles for select using (auth.uid() is not null);
create policy roles_admin_write on roles for all using (is_admin()) with check (is_admin());

create policy lead_sources_select_all on lead_sources for select using (auth.uid() is not null);
create policy lead_sources_admin_write on lead_sources for insert with check (is_admin());
create policy lead_sources_admin_update on lead_sources for update using (is_admin()) with check (is_admin());

create policy lead_stages_select_all on lead_stages for select using (auth.uid() is not null);
create policy lead_stages_admin_write on lead_stages for insert with check (is_admin());
create policy lead_stages_admin_update on lead_stages for update using (is_admin()) with check (is_admin());

create policy lenders_select_non_consultant on lenders
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy lenders_admin_write on lenders for insert with check (is_admin());
create policy lenders_admin_update on lenders for update using (is_admin()) with check (is_admin());

-- =========================================================
-- DEAL STAGES / STAGE STATUSES / REASON LOOKUPS
-- Reference data: readable by everyone with deal visibility (not
-- Consultants/BD, who never see deal-level data at all), admin-writable.
-- =========================================================
create policy deal_stages_select on deal_stages
  for select using (is_admin() or is_manager() or is_rm() or is_counselor() or is_lender_side());
create policy deal_stages_admin_write on deal_stages for insert with check (is_admin());
create policy deal_stages_admin_update on deal_stages for update using (is_admin()) with check (is_admin());

create policy deal_stage_statuses_select on deal_stage_statuses
  for select using (is_admin() or is_manager() or is_rm() or is_counselor() or is_lender_side());
create policy deal_stage_statuses_admin_write on deal_stage_statuses for insert with check (is_admin());
create policy deal_stage_statuses_admin_update on deal_stage_statuses for update using (is_admin()) with check (is_admin());

create policy deal_rejection_reasons_select on deal_rejection_reasons
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy deal_rejection_reasons_admin_write on deal_rejection_reasons for insert with check (is_admin());
create policy deal_rejection_reasons_admin_update on deal_rejection_reasons for update using (is_admin()) with check (is_admin());

create policy deal_hold_reasons_select on deal_hold_reasons
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy deal_hold_reasons_admin_write on deal_hold_reasons for insert with check (is_admin());
create policy deal_hold_reasons_admin_update on deal_hold_reasons for update using (is_admin()) with check (is_admin());

-- =========================================================
-- USERS — unchanged
-- =========================================================
create policy users_select_self on users for select using (id = auth.uid());
create policy users_select_admin on users for select using (is_admin());
create policy users_select_manager_team on users for select using (is_manager() and reporting_manager_id = auth.uid());
create policy users_select_referenced_on_own_leads on users
  for select using (
    exists (
      select 1 from leads l
      where (l.assigned_rm_id = users.id or l.source_user_id = users.id)
        and (l.assigned_rm_id = auth.uid() or l.source_user_id = auth.uid())
    )
  );
create policy users_admin_write on users for insert with check (is_admin());
create policy users_admin_update on users for update using (is_admin() or id = auth.uid()) with check (is_admin() or id = auth.uid());

-- =========================================================
-- LEADS — extended to include Counselor visibility via their deals
-- =========================================================
create policy leads_select_admin on leads for select using (is_admin());
create policy leads_select_manager on leads for select using (
  is_manager() and (assigned_manager_id = auth.uid() or rm_reports_to_current_manager(assigned_rm_id))
);
create policy leads_select_rm on leads for select using (is_rm() and assigned_rm_id = auth.uid());
create policy leads_select_source on leads for select using (is_source_role() and source_user_id = auth.uid());
create policy leads_select_counselor on leads for select using (
  is_counselor() and exists (select 1 from deals d where d.lead_id = leads.id and d.assigned_counselor_id = auth.uid())
);

create policy leads_insert_admin on leads for insert with check (is_admin());
create policy leads_insert_manager on leads for insert with check (is_manager());
create policy leads_insert_rm on leads for insert with check (is_rm());
create policy leads_insert_source on leads for insert with check (is_source_role() and source_user_id = auth.uid());

create policy leads_update_admin on leads for update using (is_admin()) with check (is_admin());
create policy leads_update_manager on leads for update using (
  is_manager() and (assigned_manager_id = auth.uid() or rm_reports_to_current_manager(assigned_rm_id))
) with check (
  is_manager() and (assigned_manager_id = auth.uid() or rm_reports_to_current_manager(assigned_rm_id))
);
create policy leads_update_rm on leads for update using (is_rm() and assigned_rm_id = auth.uid())
  with check (is_rm() and assigned_rm_id = auth.uid());

-- =========================================================
-- CO_APPLICANTS / LEAD_ASSIGNMENTS / LEAD_EVENTS — unchanged
-- (cascade from lead visibility, same as REV 1)
-- =========================================================
create policy co_applicants_select on co_applicants for select using (can_view_lead(lead_id));
create policy co_applicants_write on co_applicants for insert with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
);
create policy co_applicants_update on co_applicants for update using (
  is_admin() or (is_rm() and can_view_lead(lead_id))
) with check (
  is_admin() or (is_rm() and can_view_lead(lead_id))
);

create policy lead_assignments_select on lead_assignments for select using (
  is_admin()
  or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  or (is_rm() and assigned_to_user_id = auth.uid())
);
create policy lead_assignments_insert on lead_assignments for insert with check (is_admin() or is_manager());

create policy lead_events_select on lead_events for select using (can_view_lead(lead_id));
create policy lead_events_insert on lead_events for insert with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
);

-- =========================================================
-- DEALS — the core of this revision.
-- Consultants/BD still never see deals at all (commercially sensitive).
-- Counselors see only deals they're assigned to. Lender-side users see
-- only deals where they are the named loan officer or bank RM.
-- =========================================================
create policy deals_select on deals for select using (can_view_deal(id));

create policy deals_insert on deals for insert with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
);

create policy deals_update on deals for update using (
  is_admin()
  or (is_rm() and can_view_lead(lead_id))
  or (is_counselor() and assigned_counselor_id = auth.uid())
  or (is_lender_side() and assigned_loan_officer_id = auth.uid())
) with check (
  is_admin()
  or (is_rm() and can_view_lead(lead_id))
  or (is_counselor() and assigned_counselor_id = auth.uid())
  or (is_lender_side() and assigned_loan_officer_id = auth.uid())
);

-- =========================================================
-- STAGE-SPECIFIC DETAIL TABLES — cascade from deal visibility
-- =========================================================
create policy deal_bank_prospect_details_select on deal_bank_prospect_details for select using (can_view_deal(deal_id));
create policy deal_bank_prospect_details_write on deal_bank_prospect_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_bank_prospect_details_update on deal_bank_prospect_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and bank_rm_id = auth.uid())
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and bank_rm_id = auth.uid())
);

create policy deal_login_details_select on deal_login_details for select using (can_view_deal(deal_id));
create policy deal_login_details_write on deal_login_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_login_details_update on deal_login_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);

create policy deal_sanction_details_select on deal_sanction_details for select using (can_view_deal(deal_id));
create policy deal_sanction_details_write on deal_sanction_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_sanction_details_update on deal_sanction_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);

create policy deal_pf_details_select on deal_pf_details for select using (can_view_deal(deal_id));
create policy deal_pf_details_write on deal_pf_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_pf_details_update on deal_pf_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);

-- =========================================================
-- DEAL_EVENTS — append-only, cascades from deal visibility.
-- No UPDATE/DELETE policy exists for anyone.
-- =========================================================
create policy deal_events_select on deal_events for select using (can_view_deal(deal_id));
create policy deal_events_insert on deal_events for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

-- =========================================================
-- DISBURSEMENTS — cascades from deal visibility
-- =========================================================
create policy disbursements_select on disbursements for select using (can_view_deal(deal_id));
create policy disbursements_write on disbursements for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);


-- =========================================================
-- SOURCE: lead-management/sql/003_seed_data.sql
-- =========================================================
-- =========================================================
-- SEED DATA — safe to run once on a fresh database
-- =========================================================

insert into roles (name, description) values
  ('Admin', 'Full platform access'),
  ('Manager', 'Oversees a team of RMs, sees team-wide dashboards'),
  ('Relationship Manager', 'Owns assigned leads end-to-end'),
  ('Business Development', 'Generates leads through partnerships/campaigns'),
  ('Consultant', 'External partner submitting student leads'),
  ('Counselor', 'Internal sales team member, assignable per deal'),
  ('Lender', 'Future: lending partner login (loan officers, bank RMs)')
on conflict (name) do nothing;

insert into lead_stages (name, sequence_order, is_terminal, color) values
  ('Lead Created',          10, false, '#888780'),
  ('Contacted',             20, false, '#378ADD'),
  ('Connected',             30, false, '#378ADD'),
  ('Interested',            40, false, '#1D9E75'),
  ('Documents Requested',   50, false, '#BA7517'),
  ('Documents Received',    60, false, '#BA7517'),
  ('Shared With Lender',    70, false, '#7F77DD'),
  ('Sanctioned',            80, false, '#639922'),
  ('PF Paid',               90, false, '#639922'),
  ('Disbursed',            100, true,  '#0F6E56'),
  ('Dropped',              110, true,  '#E24B4A'),
  ('Lost',                 120, true,  '#E24B4A')
on conflict (name) do nothing;

insert into lead_sources (name, category) values
  ('Direct Website Inquiry', 'Direct'),
  ('WhatsApp Inbound',       'Direct'),
  ('Consultant Referral',    'Consultant'),
  ('BD Partnership',         'Business Development'),
  ('University Tie-up',      'Business Development'),
  ('Digital Campaign',       'Campaign'),
  ('Existing Customer Referral', 'Referral')
on conflict do nothing;

-- =========================================================
-- DEAL STAGES — per the Deal Stage Flow diagram
-- =========================================================
insert into deal_stages (name, sequence_order, is_terminal) values
  ('Bank Prospect', 10, false),
  ('Login',         20, false),
  ('Sanction',      30, false),
  ('PF',            40, false),
  ('Disbursement',  50, false),
  ('Closed Won',    60, true)
on conflict (name) do nothing;

-- =========================================================
-- DEAL STAGE STATUSES — "positive path" sub-status per stage.
-- On Hold / Rejected are deliberately excluded here; they're
-- overlay flags on the deal itself (deals.is_on_hold / is_rejected).
-- =========================================================
insert into deal_stage_statuses (deal_stage_id, name, sequence_order, is_terminal_for_stage)
select id, 'Open', 10, false from deal_stages where name = 'Bank Prospect'
union all
select id, 'Moved to Login', 20, true from deal_stages where name = 'Bank Prospect'
union all
select id, 'Login Pending', 10, false from deal_stages where name = 'Login'
union all
select id, 'Login Done', 20, true from deal_stages where name = 'Login'
union all
select id, 'Sanction Pending', 10, false from deal_stages where name = 'Sanction'
union all
select id, 'Sanction Approved', 20, true from deal_stages where name = 'Sanction'
union all
select id, 'PF Pending', 10, false from deal_stages where name = 'PF'
union all
select id, 'PF Paid', 20, true from deal_stages where name = 'PF'
union all
select id, 'Requested', 10, false from deal_stages where name = 'Disbursement'
union all
select id, 'Partially Disbursed', 20, false from deal_stages where name = 'Disbursement'
union all
select id, 'Fully Disbursed', 30, true from deal_stages where name = 'Disbursement'
union all
select id, 'Closed Won', 10, true from deal_stages where name = 'Closed Won'
on conflict (deal_stage_id, name) do nothing;

-- =========================================================
-- DEAL REJECTION REASONS
-- =========================================================
insert into deal_rejection_reasons (name) values
  ('Credit Score'),
  ('Low Income'),
  ('Documentation'),
  ('Property'),
  ('Co-applicant / Eligibility'),
  ('Bank Policy'),
  ('Other')
on conflict (name) do nothing;

-- =========================================================
-- DEAL HOLD REASONS
-- =========================================================
insert into deal_hold_reasons (name) values
  ('Waiting for Student'),
  ('Waiting for Consultant'),
  ('Waiting for Bank'),
  ('Waiting for Documents'),
  ('Other')
on conflict (name) do nothing;


-- =========================================================
-- SOURCE: lead-management/sql/004_functions.sql
-- =========================================================
-- =========================================================
-- RPC FUNCTIONS — atomic writes that must never leave a
-- timeline out of sync with current state.
-- =========================================================

create or replace function change_lead_stage(
  p_lead_id uuid,
  p_new_stage_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_stage_id uuid;
begin
  select current_stage_id into v_old_stage_id from leads where id = p_lead_id for update;
  if v_old_stage_id is null then
    raise exception 'Lead % not found or not visible', p_lead_id;
  end if;

  update leads
  set current_stage_id = p_new_stage_id, last_activity_at = now(), updated_by = auth.uid()
  where id = p_lead_id;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

create or replace function assign_lead(
  p_lead_id uuid,
  p_new_rm_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_rm_id uuid;
begin
  select assigned_rm_id into v_old_rm_id from leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found or not visible', p_lead_id;
  end if;

  update lead_assignments
  set unassigned_at = now()
  where lead_id = p_lead_id and assigned_to_user_id = v_old_rm_id and unassigned_at is null;

  update leads set assigned_rm_id = p_new_rm_id, updated_by = auth.uid() where id = p_lead_id;

  insert into lead_assignments (lead_id, assigned_to_user_id, assigned_by_user_id, reason)
  values (p_lead_id, p_new_rm_id, auth.uid(), p_reason);

  insert into lead_events (lead_id, event_type, remarks, created_by, metadata)
  values (p_lead_id, 'Reassigned', p_reason, auth.uid(), jsonb_build_object('from_rm', v_old_rm_id, 'to_rm', p_new_rm_id));
end;
$$;

-- =========================================================
-- change_deal_stage — moves a deal forward (or backward) between
-- stages. Creates a blank row in the destination stage's detail
-- table if one doesn't exist yet, so the caller can immediately
-- start filling in that stage's fields. Clears is_on_hold if the
-- deal was on hold (moving stage implies it's active again) —
-- rejection is NOT auto-cleared; that requires reinstate_deal
-- explicitly, since a rejected deal resuming is a deliberate action.
-- =========================================================
create or replace function change_deal_stage(
  p_deal_id uuid,
  p_new_stage_id uuid,
  p_new_status_id uuid default null,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_stage_id uuid;
  v_new_stage_name text;
begin
  select current_deal_stage_id into v_old_stage_id from deals where id = p_deal_id for update;
  if v_old_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select name into v_new_stage_name from deal_stages where id = p_new_stage_id;

  update deals
  set current_deal_stage_id = p_new_stage_id,
      current_stage_status_id = p_new_status_id,
      is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if v_new_stage_name = 'Bank Prospect' then
    insert into deal_bank_prospect_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage_name = 'Login' then
    insert into deal_login_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage_name = 'Sanction' then
    insert into deal_sanction_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage_name = 'PF' then
    insert into deal_pf_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  end if;

  insert into deal_events (deal_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_deal_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

-- =========================================================
-- put_deal_on_hold / release_deal_hold — the "On Hold (Any Stage)"
-- overlay. Deliberately does not touch current_deal_stage_id.
-- =========================================================
create or replace function put_deal_on_hold(
  p_deal_id uuid,
  p_hold_reason_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  update deals
  set is_on_hold = true,
      hold_date = now(),
      hold_reason_id = p_hold_reason_id,
      hold_remarks = p_remarks,
      updated_by = auth.uid()
  where id = p_deal_id;

  if not found then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Put On Hold', p_remarks, auth.uid(), jsonb_build_object('hold_reason_id', p_hold_reason_id));
end;
$$;

create or replace function release_deal_hold(
  p_deal_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  update deals
  set is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if not found then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  insert into deal_events (deal_id, event_type, remarks, created_by)
  values (p_deal_id, 'Hold Released', p_remarks, auth.uid());
end;
$$;

-- =========================================================
-- reject_deal / reinstate_deal — the "Rejected (Any Stage)" overlay.
-- Records which stage the deal was AT when rejected, per the diagram's
-- "Rejection Stage" field.
-- =========================================================
create or replace function reject_deal(
  p_deal_id uuid,
  p_rejection_reason_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_current_stage_id uuid;
begin
  select current_deal_stage_id into v_current_stage_id from deals where id = p_deal_id for update;
  if v_current_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  update deals
  set is_rejected = true,
      rejection_date = now(),
      rejection_stage_id = v_current_stage_id,
      rejection_reason_id = p_rejection_reason_id,
      rejection_remarks = p_remarks,
      is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, from_stage_id, remarks, created_by, metadata)
  values (p_deal_id, 'Rejected', v_current_stage_id, p_remarks, auth.uid(), jsonb_build_object('rejection_reason_id', p_rejection_reason_id));
end;
$$;

create or replace function reinstate_deal(
  p_deal_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  update deals
  set is_rejected = false,
      rejection_date = null,
      rejection_stage_id = null,
      rejection_reason_id = null,
      rejection_remarks = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if not found then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  insert into deal_events (deal_id, event_type, remarks, created_by)
  values (p_deal_id, 'Reinstated', p_remarks, auth.uid());
end;
$$;

-- =========================================================
-- record_disbursement — adds a tranche and keeps the deals-level
-- cache (total_disbursed_amount) in sync in the same transaction.
-- Moving to Closed Won is a separate, deliberate change_deal_stage
-- call — this function does not do it automatically, since "fully
-- disbursed" per the diagram is a stage-status judgment call, not
-- purely a sum-of-tranches calculation.
-- =========================================================
create or replace function record_disbursement(
  p_deal_id uuid,
  p_tranche_number integer,
  p_amount numeric,
  p_disbursed_date date,
  p_academic_term text default null,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  insert into disbursements (deal_id, tranche_number, amount, disbursed_date, academic_term, remarks, created_by)
  values (p_deal_id, p_tranche_number, p_amount, p_disbursed_date, p_academic_term, p_remarks, auth.uid());

  update deals
  set total_disbursed_amount = coalesce((select sum(amount) from disbursements where deal_id = p_deal_id and is_deleted = false), 0),
      updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Disbursement Recorded', p_remarks, auth.uid(), jsonb_build_object('tranche_number', p_tranche_number, 'amount', p_amount));
end;
$$;


-- =========================================================
-- SOURCE: authentication/sql/001_schema.sql
-- =========================================================
-- =========================================================
-- AUTHENTICATION APPLICATION — SCHEMA
-- =========================================================
-- `users` and `roles` already exist (created by Lead Management as
-- provisional stubs). This application does NOT recreate them — it
-- takes ownership of their lifecycle: invites, activation, role
-- changes, deactivation. Per the platform's shared-DB philosophy,
-- this app ADDS tables on top of what already exists.
-- =========================================================

-- =========================================================
-- INVITATIONS — tracks the invite lifecycle before a user accepts
-- and gets a real auth.users row. Actual email dispatch and auth.users
-- creation happens via a Supabase Edge Function using the service_role
-- key (inviteUserByEmail) — this table is the durable record of intent,
-- not the mechanism that sends the email.
-- =========================================================
create table invitations (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null,
  full_name             text not null,
  role_id               uuid not null references roles(id),
  reporting_manager_id  uuid references users(id),
  invited_by            uuid not null references users(id),
  invited_at            timestamptz not null default now(),
  expires_at            timestamptz not null default (now() + interval '7 days'),
  accepted_at           timestamptz,
  accepted_user_id      uuid references users(id),
  revoked_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'pending'
                          check (status in ('pending','accepted','expired','revoked'))
);

create index idx_invitations_email on invitations(email);
create index idx_invitations_status on invitations(status);

create trigger trg_invitations_updated_at
  before update on invitations
  for each row execute function set_updated_at();

-- =========================================================
-- USER ROLE EVENTS — append-only audit trail for every security-
-- sensitive change to a user's account: role change, manager
-- reassignment, activation, deactivation. Same "never overwrite,
-- always create an event" principle as lead_events/deal_events.
-- =========================================================
create table user_role_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id),
  event_type          text not null
                        check (event_type in ('Invited','Activated','Role Changed','Manager Changed','Deactivated','Reactivated')),
  old_role_id         uuid references roles(id),
  new_role_id         uuid references roles(id),
  old_manager_id      uuid references users(id),
  new_manager_id      uuid references users(id),
  remarks             text,
  created_at          timestamptz not null default now(),
  created_by          uuid references users(id),
  is_deleted          boolean not null default false,
  status              text not null default 'active'
);

create index idx_user_role_events_user_id_created_at on user_role_events(user_id, created_at desc);


-- =========================================================
-- SOURCE: authentication/sql/002_rls_policies.sql
-- =========================================================
-- =========================================================
-- ROW LEVEL SECURITY — AUTHENTICATION
-- =========================================================
-- Reuses is_admin()/is_manager() etc. from Lead Management's RLS file,
-- which must be applied before this one (same database, same helpers).
-- =========================================================

alter table invitations enable row level security;
alter table invitations force row level security;
alter table user_role_events enable row level security;
alter table user_role_events force row level security;

-- Only Admins manage invitations. Nobody else can even see pending
-- invites (an unaccepted invite reveals a future hire's email/role).
create policy invitations_admin_all on invitations
  for all using (is_admin()) with check (is_admin());

-- Users can see their own role-change history; Managers can see it for
-- their direct reports; Admin sees everything. Nobody can write directly
-- — only the RPC functions below insert into this table (security
-- definer), keeping the audit trail tamper-proof from the client.
create policy user_role_events_select_self on user_role_events
  for select using (user_id = auth.uid());
create policy user_role_events_select_admin on user_role_events
  for select using (is_admin());
create policy user_role_events_select_manager on user_role_events
  for select using (is_manager() and rm_reports_to_current_manager(user_id));

-- No insert/update/delete policy for any role — writes only happen
-- via SECURITY DEFINER functions (004_functions.sql), never directly.


-- =========================================================
-- SOURCE: authentication/sql/003_functions.sql
-- =========================================================
-- =========================================================
-- RPC FUNCTIONS — AUTHENTICATION
-- All SECURITY DEFINER + an explicit is_admin() check inside the
-- function body, since user_role_events has no direct insert policy
-- for anyone — these functions are the only way to write to it.
-- =========================================================

create or replace function invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can invite users';
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, invited_by)
  values (p_email, p_full_name, p_role_id, p_reporting_manager_id, auth.uid())
  returning id into v_invitation_id;

  -- NOTE: this function only records intent. The actual email send and
  -- auth.users row creation happens in a Supabase Edge Function using
  -- the service_role key (supabase.auth.admin.inviteUserByEmail), which
  -- the Admin UI calls right after this. See docs/README.md.
  return v_invitation_id;
end;
$$;

-- Called by the Edge Function (service_role context) once the invited
-- person has set their password and Supabase has created their
-- auth.users row. Creates the matching `users` profile row and closes
-- out the invitation.
create or replace function accept_invitation(
  p_invitation_id uuid,
  p_new_auth_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
begin
  select * into v_invite from invitations where id = p_invitation_id and status = 'pending' for update;
  if not found then
    raise exception 'Invitation % not found or already used', p_invitation_id;
  end if;
  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'Invitation % has expired', p_invitation_id;
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, created_by)
  values (p_new_auth_user_id, v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.invited_by);

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = p_new_auth_user_id
  where id = p_invitation_id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (p_new_auth_user_id, 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;

create or replace function revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an Admin can revoke invitations';
  end if;
  update invitations set status = 'revoked', revoked_at = now() where id = p_invitation_id and status = 'pending';
end;
$$;

-- =========================================================
-- accept_my_invitation — called by the INVITED USER themselves,
-- immediately after they set their password via the emailed invite
-- link (which gives them a valid Supabase session but no `users` row
-- yet, so no role and no other permissions). Matches on JWT email
-- rather than a passed-in invitation ID, so the invited person can't
-- accept an invitation that wasn't sent to them.
-- =========================================================
create or replace function accept_my_invitation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
  v_email text;
begin
  v_email := auth.jwt() ->> 'email';
  if v_email is null then
    raise exception 'No authenticated email found on this session';
  end if;

  select * into v_invite from invitations
  where email = v_email and status = 'pending'
  order by invited_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No pending invitation found for %', v_email;
  end if;

  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = v_invite.id;
    raise exception 'This invitation has expired — ask your admin to send a new one';
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, created_by)
  values (auth.uid(), v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.invited_by)
  on conflict (id) do nothing;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
  where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (auth.uid(), 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;

create or replace function change_user_role(
  p_target_user_id uuid,
  p_new_role_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can change a user''s role';
  end if;

  select role_id into v_old_role_id from users where id = p_target_user_id for update;
  if v_old_role_id is null then
    raise exception 'User % not found', p_target_user_id;
  end if;

  update users set role_id = p_new_role_id, updated_by = auth.uid() where id = p_target_user_id;

  insert into user_role_events (user_id, event_type, old_role_id, new_role_id, remarks, created_by)
  values (p_target_user_id, 'Role Changed', v_old_role_id, p_new_role_id, p_remarks, auth.uid());
end;
$$;

create or replace function change_reporting_manager(
  p_target_user_id uuid,
  p_new_manager_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_manager_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can change reporting managers';
  end if;

  select reporting_manager_id into v_old_manager_id from users where id = p_target_user_id for update;

  update users set reporting_manager_id = p_new_manager_id, updated_by = auth.uid() where id = p_target_user_id;

  insert into user_role_events (user_id, event_type, old_manager_id, new_manager_id, remarks, created_by)
  values (p_target_user_id, 'Manager Changed', v_old_manager_id, p_new_manager_id, p_remarks, auth.uid());
end;
$$;

create or replace function deactivate_user(
  p_target_user_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an Admin can deactivate a user';
  end if;

  update users set is_active = false, updated_by = auth.uid() where id = p_target_user_id;
  if not found then
    raise exception 'User % not found', p_target_user_id;
  end if;

  insert into user_role_events (user_id, event_type, remarks, created_by)
  values (p_target_user_id, 'Deactivated', p_remarks, auth.uid());
end;
$$;

create or replace function reactivate_user(
  p_target_user_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an Admin can reactivate a user';
  end if;

  update users set is_active = true, updated_by = auth.uid() where id = p_target_user_id;
  if not found then
    raise exception 'User % not found', p_target_user_id;
  end if;

  insert into user_role_events (user_id, event_type, remarks, created_by)
  values (p_target_user_id, 'Reactivated', p_remarks, auth.uid());
end;
$$;


-- =========================================================
-- SOURCE: consultant-portal/sql/001_schema.sql
-- =========================================================
-- =========================================================
-- CONSULTANT PORTAL — SCHEMA
-- This app is mostly a scoped UI over Lead Management's existing
-- tables (leads, lead_events, co_applicants) — no new tables needed
-- for "My Students" or "Lead Status", since RLS already restricts
-- Consultants to their own sourced leads. The one new piece: Messages.
-- =========================================================

create table lead_messages (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads(id) on delete cascade,
  sender_id       uuid not null references users(id),
  message         text not null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_lead_messages_lead_id_created_at on lead_messages(lead_id, created_at asc);

create trigger trg_lead_messages_updated_at
  before update on lead_messages
  for each row execute function set_updated_at();


-- =========================================================
-- SOURCE: consultant-portal/sql/002_rls_policies.sql
-- =========================================================
-- =========================================================
-- ROW LEVEL SECURITY — CONSULTANT PORTAL (lead_messages)
-- Reuses can_view_lead() from Lead Management's RLS file.
-- =========================================================

alter table lead_messages enable row level security;
alter table lead_messages force row level security;

-- Visible to anyone who can already see the lead (Consultant/BD who
-- sourced it, or RM/Manager/Admin handling it) — cascades from the
-- same visibility rule as lead_events, no new logic needed.
create policy lead_messages_select on lead_messages
  for select using (can_view_lead(lead_id));

create policy lead_messages_insert on lead_messages
  for insert with check (can_view_lead(lead_id) and sender_id = auth.uid());

-- No update/delete policy — messages are immutable once sent, same
-- "never overwrite" principle as every other event/timeline table.


-- =========================================================
-- SOURCE: rm-workspace/sql/001_schema.sql
-- =========================================================
-- =========================================================
-- RM WORKSPACE — SCHEMA
-- Reuses leads/lead_events/deals/deal_events from Lead Management.
-- Only new table: tasks (a personal to-do list, optionally tied to a lead).
-- =========================================================

create table tasks (
  id                    uuid primary key default gen_random_uuid(),
  assigned_to_user_id   uuid not null references users(id),
  lead_id               uuid references leads(id) on delete set null,
  title                 text not null,
  description           text,
  due_date              date,
  is_completed          boolean not null default false,
  completed_at          timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'active'
);

create index idx_tasks_assigned_to on tasks(assigned_to_user_id);
create index idx_tasks_due_date on tasks(due_date);
create index idx_tasks_lead_id on tasks(lead_id);

create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();


-- =========================================================
-- SOURCE: rm-workspace/sql/002_rls_policies.sql
-- =========================================================
-- =========================================================
-- ROW LEVEL SECURITY — RM WORKSPACE (tasks)
-- =========================================================

alter table tasks enable row level security;
alter table tasks force row level security;

create policy tasks_select on tasks
  for select using (
    is_admin()
    or assigned_to_user_id = auth.uid()
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

create policy tasks_insert on tasks
  for insert with check (
    is_admin()
    or assigned_to_user_id = auth.uid()
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

create policy tasks_update on tasks
  for update using (
    is_admin()
    or assigned_to_user_id = auth.uid()
  ) with check (
    is_admin()
    or assigned_to_user_id = auth.uid()
  );


-- =========================================================
-- SOURCE: document-management/sql/001_schema.sql
-- =========================================================
-- =========================================================
-- DOCUMENT MANAGEMENT — SCHEMA
-- Actual file bytes live in Supabase Storage (a bucket named
-- "lead-documents"); this table tracks metadata + verification
-- workflow. Per the brief, document handling is internal-team-only
-- (RM/Manager/Admin/Counselor) — Consultants don't have a Documents
-- nav item, matching your original role scope.
-- =========================================================

create table document_types (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  applies_to      text not null default 'Student' check (applies_to in ('Student','Co-applicant','Both')),
  is_required     boolean not null default false,
  sequence_order  integer not null default 100,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create trigger trg_document_types_updated_at
  before update on document_types
  for each row execute function set_updated_at();

create table documents (
  id                    uuid primary key default gen_random_uuid(),
  lead_id               uuid not null references leads(id) on delete cascade,
  co_applicant_id       uuid references co_applicants(id) on delete cascade, -- null = belongs to the student
  document_type_id      uuid not null references document_types(id),

  -- Storage Bucket reference. Actual bytes live in Supabase Storage;
  -- this row is metadata + workflow only.
  storage_path          text not null,
  file_name             text not null,
  file_size_bytes       bigint,
  mime_type             text,

  uploaded_by           uuid not null references users(id),
  uploaded_at           timestamptz not null default now(),

  verification_status   text not null default 'Pending Review'
                          check (verification_status in ('Pending Review','Verified','Rejected')),
  verified_by           uuid references users(id),
  verified_at           timestamptz,
  rejection_reason      text,
  remarks               text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'active'
);

create index idx_documents_lead_id on documents(lead_id);
create index idx_documents_verification_status on documents(verification_status);
create index idx_documents_co_applicant_id on documents(co_applicant_id);

create trigger trg_documents_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- =========================================================
-- Append-only event log, same pattern as lead_events/deal_events.
-- Every upload, verify, reject, replace is an immutable row.
-- =========================================================
create table document_events (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  event_type      text not null check (event_type in ('Uploaded','Verified','Rejected','Replaced')),
  remarks         text,
  created_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_document_events_document_id on document_events(document_id, created_at desc);


-- =========================================================
-- SOURCE: document-management/sql/002_rls_policies.sql
-- =========================================================
-- =========================================================
-- ROW LEVEL SECURITY — DOCUMENT MANAGEMENT
-- Internal-team-only, matching the brief: Consultants/BD have no
-- Documents nav item and never see document rows, same lockout
-- pattern as deals.
-- =========================================================

alter table document_types enable row level security;
alter table document_types force row level security;
alter table documents enable row level security;
alter table documents force row level security;
alter table document_events enable row level security;
alter table document_events force row level security;

create policy document_types_select on document_types
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy document_types_admin_write on document_types
  for insert with check (is_admin());
create policy document_types_admin_update on document_types
  for update using (is_admin()) with check (is_admin());

create policy documents_select on documents
  for select using (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
  );

create policy documents_insert on documents
  for insert with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
  );

-- Only the verification fields should really change after upload;
-- enforced by convention in the service layer (update sets only
-- verification_status/verified_by/verified_at/rejection_reason),
-- RLS grants the same roles as insert since re-uploads (replace) also
-- go through update in the current design.
create policy documents_update on documents
  for update using (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
  ) with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
  );

create policy document_events_select on document_events
  for select using (
    is_admin()
    or exists (select 1 from documents d where d.id = document_events.document_id and can_view_lead(d.lead_id))
  );
create policy document_events_insert on document_events
  for insert with check (
    is_admin()
    or exists (select 1 from documents d where d.id = document_events.document_id and can_view_lead(d.lead_id))
  );


-- =========================================================
-- SOURCE: document-management/sql/003_functions.sql
-- =========================================================
-- =========================================================
-- RPC FUNCTIONS — DOCUMENT MANAGEMENT
-- =========================================================

create or replace function upload_document_record(
  p_lead_id uuid,
  p_document_type_id uuid,
  p_storage_path text,
  p_file_name text,
  p_file_size_bytes bigint,
  p_mime_type text,
  p_co_applicant_id uuid default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_document_id uuid;
begin
  insert into documents (lead_id, co_applicant_id, document_type_id, storage_path, file_name, file_size_bytes, mime_type, uploaded_by, created_by)
  values (p_lead_id, p_co_applicant_id, p_document_type_id, p_storage_path, p_file_name, p_file_size_bytes, p_mime_type, auth.uid(), auth.uid())
  returning id into v_document_id;

  insert into document_events (document_id, event_type, created_by)
  values (v_document_id, 'Uploaded', auth.uid());

  return v_document_id;
end;
$$;

create or replace function verify_document(p_document_id uuid, p_remarks text default null)
returns void
language plpgsql
security invoker
as $$
begin
  update documents
  set verification_status = 'Verified', verified_by = auth.uid(), verified_at = now(), remarks = p_remarks, updated_by = auth.uid()
  where id = p_document_id;
  if not found then raise exception 'Document % not found or not visible', p_document_id; end if;

  insert into document_events (document_id, event_type, remarks, created_by)
  values (p_document_id, 'Verified', p_remarks, auth.uid());
end;
$$;

create or replace function reject_document(p_document_id uuid, p_rejection_reason text)
returns void
language plpgsql
security invoker
as $$
begin
  update documents
  set verification_status = 'Rejected', verified_by = auth.uid(), verified_at = now(), rejection_reason = p_rejection_reason, updated_by = auth.uid()
  where id = p_document_id;
  if not found then raise exception 'Document % not found or not visible', p_document_id; end if;

  insert into document_events (document_id, event_type, remarks, created_by)
  values (p_document_id, 'Rejected', p_rejection_reason, auth.uid());
end;
$$;


-- =========================================================
-- SOURCE: document-management/sql/004_seed_data.sql
-- =========================================================
insert into document_types (name, applies_to, is_required, sequence_order) values
  ('Passport', 'Student', true, 10),
  ('PAN Card', 'Student', true, 20),
  ('Aadhaar Card', 'Student', true, 30),
  ('Admission Letter', 'Student', true, 40),
  ('Academic Transcripts', 'Student', true, 50),
  ('English Test Score (IELTS/TOEFL/GRE)', 'Student', false, 60),
  ('Co-applicant PAN Card', 'Co-applicant', true, 70),
  ('Co-applicant Income Proof', 'Co-applicant', true, 80),
  ('Co-applicant Bank Statements', 'Co-applicant', true, 90),
  ('Property Documents', 'Co-applicant', false, 100)
on conflict (name) do nothing;


-- =========================================================
-- SOURCE: lender-pipeline/sql/001_schema.sql
-- =========================================================
-- =========================================================
-- LENDER PIPELINE — SCHEMA
-- Extends `users` (owned long-term by Authentication) with which
-- lender organization a Lender-role user belongs to. Without this,
-- a bank's team can't see deals shared with their own bank unless
-- they happen to be the one specifically named as loan officer —
-- which doesn't match how lending teams actually work (whoever's on
-- duty picks up a shared case, it's not always the same named person).
-- =========================================================

alter table users add column if not exists lender_organization_id uuid references lenders(id);

create index if not exists idx_users_lender_organization_id on users(lender_organization_id);

-- =========================================================
-- LENDER-SIDE REMARKS — a lightweight thread the lender's team and
-- our internal team (RM/Counselor) use to communicate on a specific
-- deal, separate from deal_events (which is an immutable system log,
-- not a conversation).
-- =========================================================
create table lender_deal_messages (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals(id) on delete cascade,
  sender_id       uuid not null references users(id),
  message         text not null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active'
);

create index idx_lender_deal_messages_deal_id on lender_deal_messages(deal_id, created_at asc);

create trigger trg_lender_deal_messages_updated_at
  before update on lender_deal_messages
  for each row execute function set_updated_at();


-- =========================================================
-- SOURCE: lender-pipeline/sql/002_rls_policies.sql
-- =========================================================
-- =========================================================
-- ROW LEVEL SECURITY — LENDER PIPELINE
-- Adds ADDITIONAL permissive policies on top of what Lead Management
-- already created — Postgres OR's multiple permissive policies for
-- the same table+command together, so this broadens Lender-side
-- access (org-wide) without touching or weakening the existing
-- per-officer policies.
-- =========================================================

create or replace function belongs_to_lender_org(p_lender_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_lender_side() and exists (
    select 1 from users u where u.id = auth.uid() and u.lender_organization_id = p_lender_id
  )
$$;

-- ---------------------------------------------------------
-- DEALS — any user from the lender's own organization can see and
-- act on deals shared with their bank, not just the named officer.
-- ---------------------------------------------------------
create policy deals_select_lender_org on deals
  for select using (belongs_to_lender_org(lender_id));

create policy deals_update_lender_org on deals
  for update using (belongs_to_lender_org(lender_id)) with check (belongs_to_lender_org(lender_id));

-- ---------------------------------------------------------
-- STAGE-SPECIFIC DETAIL TABLES — this was the actual gap: the
-- original policies let the internal team edit these, but never
-- granted the lender's own team write access, even though updating
-- these fields (login amount, sanction terms, PF date, etc.) is
-- literally the lender's job.
-- ---------------------------------------------------------
create policy deal_bank_prospect_details_lender_org on deal_bank_prospect_details
  for update using (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  ) with check (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  );
create policy deal_bank_prospect_details_select_lender_org on deal_bank_prospect_details
  for select using (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  );
create policy deal_bank_prospect_details_insert_lender_org on deal_bank_prospect_details
  for insert with check (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  );

create policy deal_login_details_lender_org_select on deal_login_details
  for select using (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_login_details_lender_org_insert on deal_login_details
  for insert with check (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_login_details_lender_org_update on deal_login_details
  for update using (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)))
  with check (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)));

create policy deal_sanction_details_lender_org_select on deal_sanction_details
  for select using (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_sanction_details_lender_org_insert on deal_sanction_details
  for insert with check (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_sanction_details_lender_org_update on deal_sanction_details
  for update using (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)))
  with check (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)));

create policy deal_pf_details_lender_org_select on deal_pf_details
  for select using (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_pf_details_lender_org_insert on deal_pf_details
  for insert with check (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_pf_details_lender_org_update on deal_pf_details
  for update using (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)))
  with check (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)));

-- ---------------------------------------------------------
-- DEAL EVENTS / DISBURSEMENTS — read for anyone from the lender org;
-- write only via the RPC functions (deal_events has no direct insert
-- policy for anyone — see the note in Lead Management's RLS file).
-- The RPCs themselves check deals_update-style access at the table
-- level via their internal `update deals ...` calls, which the new
-- deals_update_lender_org policy above now covers.
-- ---------------------------------------------------------
create policy deal_events_select_lender_org on deal_events
  for select using (exists (select 1 from deals d where d.id = deal_events.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_events_insert_lender_org on deal_events
  for insert with check (exists (select 1 from deals d where d.id = deal_events.deal_id and belongs_to_lender_org(d.lender_id)));

create policy disbursements_select_lender_org on disbursements
  for select using (exists (select 1 from deals d where d.id = disbursements.deal_id and belongs_to_lender_org(d.lender_id)));
create policy disbursements_insert_lender_org on disbursements
  for insert with check (exists (select 1 from deals d where d.id = disbursements.deal_id and belongs_to_lender_org(d.lender_id)));

-- ---------------------------------------------------------
-- LENDER DEAL MESSAGES — visible to the lender org AND our internal
-- team (RM/Manager/Admin/Counselor) handling the same deal.
-- ---------------------------------------------------------
alter table lender_deal_messages enable row level security;
alter table lender_deal_messages force row level security;

create policy lender_deal_messages_select on lender_deal_messages
  for select using (
    is_admin()
    or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and (is_rm() or is_manager() or is_counselor()) and can_view_deal(d.id))
    or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and belongs_to_lender_org(d.lender_id))
  );

create policy lender_deal_messages_insert on lender_deal_messages
  for insert with check (
    sender_id = auth.uid() and (
      is_admin()
      or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and (is_rm() or is_manager() or is_counselor()) and can_view_deal(d.id))
      or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and belongs_to_lender_org(d.lender_id))
    )
  );


-- =========================================================
-- SOURCE: lender-pipeline/sql/003_lender_profile.sql
-- =========================================================
-- =========================================================
-- LENDER PIPELINE — bank profile details
-- Lets a Lender's own team update their institution's details
-- (previously `lenders` only had name/code, set up by Admin only).
-- =========================================================

alter table lenders add column if not exists contact_person_name text;
alter table lenders add column if not exists contact_email text;
alter table lenders add column if not exists contact_phone text;
alter table lenders add column if not exists registered_address text;
alter table lenders add column if not exists processing_notes text; -- e.g. "Sanctions typically take 5-7 business days"

-- Lender org members can update their OWN institution's profile;
-- Admin can update any. Reuses belongs_to_lender_org() from 002.
create policy lenders_update_own_org on lenders
  for update using (belongs_to_lender_org(id)) with check (belongs_to_lender_org(id));

-- GAP FOUND WHILE ADDING THE ABOVE: the original lenders SELECT policy
-- (lenders_select_non_consultant) never included Lender-role users at
-- all — meaning a Lender couldn't see their own institution's name,
-- even embedded via deals.lenders(name). Fixing it here.
create policy lenders_select_own_org on lenders
  for select using (belongs_to_lender_org(id));

-- =========================================================
-- SOURCE: lead-management/sql/005_lead_details_extension.sql
-- =========================================================

-- ---------------------------------------------------------
-- Extend LEADS — Personal ID, Loan Identification, Addresses,
-- Alternate Contact, Employment (Applicant)
-- ---------------------------------------------------------
alter table leads
  add column gender text check (gender in ('Male','Female','Other')),
  add column marital_status text check (marital_status in ('Single','Married','Divorced','Widowed')),
  add column pan_number text,
  add column aadhaar_number text,
  add column passport_number text,
  add column citizenship text default 'India',

  add column degree text,
  add column admission_offer_status text check (admission_offer_status in ('Not Applied','Applied','Conditional','Finalised','Rejected')),
  add column loan_type text check (loan_type in ('Collateral','Non Collateral')),
  add column applicant_financial_status text check (applicant_financial_status in ('Employed','Not Employed','Self-Employed','Student')),
  add column english_test_waived_off boolean not null default false,
  add column aptitude_waived_off boolean not null default false,
  add column have_cosigner boolean not null default false,
  add column cosigner_relationship text,
  add column coapplicant_financial_status text,
  add column agricultural_income boolean not null default false,
  add column total_study_cost numeric(14,2),
  add column parent_alternate_number text,
  add column self_funds_available numeric(14,2),

  add column current_address text,
  add column current_city text,
  add column current_state text,
  add column current_country text,
  add column current_pincode text,
  add column permanent_address text,
  add column permanent_city text,
  add column permanent_state text,
  add column permanent_country text,
  add column permanent_pincode text,

  add column alternate_phone text,

  add column employment_status text,
  add column credit_score integer check (credit_score is null or credit_score between 300 and 900),
  add column savings_amount numeric(14,2),
  add column has_liabilities boolean not null default false,
  add column liabilities_amount numeric(14,2);

-- ---------------------------------------------------------
-- Extend CO_APPLICANTS — DOB, Aadhaar, employment + bank details
-- ---------------------------------------------------------
alter table co_applicants
  add column dob date,
  add column aadhaar_number text,
  add column employer_name text,
  add column designation text,
  add column monthly_net_income numeric(14,2),
  add column credit_score integer check (credit_score is null or credit_score between 300 and 900),
  add column savings_amount numeric(14,2),
  add column has_liabilities boolean not null default false,
  add column bank_name text,
  add column branch_name text,
  add column account_number text,
  add column ifsc_code text;

-- ---------------------------------------------------------
-- LEAD_UNIVERSITY_CHOICES — "University Details 2-6" as rows
-- ---------------------------------------------------------
create table lead_university_choices (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads(id) on delete cascade,
  sequence_order  integer not null,
  university_name text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active',
  unique (lead_id, sequence_order)
);
create index idx_lead_university_choices_lead_id on lead_university_choices(lead_id);
create trigger trg_lead_university_choices_updated_at
  before update on lead_university_choices
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- LEAD_ACADEMIC_DETAILS — one row per lead
-- ---------------------------------------------------------
create table lead_academic_details (
  id                      uuid primary key default gen_random_uuid(),
  lead_id                 uuid not null unique references leads(id) on delete cascade,
  highest_qualification   text,
  english_test_taken      text,
  aptitude_test_taken     text,
  course_duration_months  integer,
  scholarship_offered     boolean not null default false,
  scholarship_amount      numeric(14,2),
  tenth_score             text,
  twelfth_score           text,
  ug_college_name         text,
  ug_course_name          text,
  ug_cgpa                 text,
  ug_graduation_year      integer,
  ug_backlogs             integer,
  pg_college_name         text,
  pg_course_name          text,
  pg_cgpa                 text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references users(id),
  updated_by              uuid references users(id),
  is_deleted              boolean not null default false,
  status                  text not null default 'active'
);
create index idx_lead_academic_details_lead_id on lead_academic_details(lead_id);
create trigger trg_lead_academic_details_updated_at
  before update on lead_academic_details
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- LEAD_PARENT_DETAILS — one row per lead
-- ---------------------------------------------------------
create table lead_parent_details (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null unique references leads(id) on delete cascade,
  father_first_name text,
  father_last_name  text,
  father_mobile     text,
  father_email      text,
  mother_first_name text,
  mother_last_name  text,
  mother_mobile     text,
  mother_email      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references users(id),
  updated_by        uuid references users(id),
  is_deleted        boolean not null default false,
  status            text not null default 'active'
);
create index idx_lead_parent_details_lead_id on lead_parent_details(lead_id);
create trigger trg_lead_parent_details_updated_at
  before update on lead_parent_details
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- LEAD_COLLATERAL_DETAILS — 1:many (multiple securities possible)
-- ---------------------------------------------------------
create table lead_collateral_details (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  security_offered boolean not null default false,
  security_type    text,
  current_value    numeric(14,2),
  owned_by         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users(id),
  updated_by       uuid references users(id),
  is_deleted       boolean not null default false,
  status           text not null default 'active'
);
create index idx_lead_collateral_details_lead_id on lead_collateral_details(lead_id);
create trigger trg_lead_collateral_details_updated_at
  before update on lead_collateral_details
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- LEAD_REFERENCES — one row per (lead, reference_type)
-- ---------------------------------------------------------
create table lead_references (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references leads(id) on delete cascade,
  reference_type text not null check (reference_type in ('Applicant','Co-Applicant')),
  first_name     text,
  last_name      text,
  phone          text,
  email          text,
  address        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  updated_by     uuid references users(id),
  is_deleted     boolean not null default false,
  status         text not null default 'active',
  unique (lead_id, reference_type)
);
create index idx_lead_references_lead_id on lead_references(lead_id);
create trigger trg_lead_references_updated_at
  before update on lead_references
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- RLS — same shape already proven on co_applicants: visible/
-- writable by anyone who can see the parent lead (Admin always,
-- Manager/RM scoped via can_view_lead()).
-- ---------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'lead_university_choices','lead_academic_details','lead_parent_details',
    'lead_collateral_details','lead_references'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I_select on %I for select using (can_view_lead(lead_id))', t, t);
    execute format(
      'create policy %I_write on %I for insert with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)))',
      t, t
    );
    execute format(
      'create policy %I_update on %I for update using (is_admin() or (is_rm() and can_view_lead(lead_id))) with check (is_admin() or (is_rm() and can_view_lead(lead_id)))',
      t, t
    );
  end loop;
end $$;

-- =========================================================
-- SOURCE: lender-pipeline/sql/004_deal_queries.sql
-- =========================================================

create table deal_query_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  is_deleted  boolean not null default false,
  status      text not null default 'active'
);
create trigger trg_deal_query_categories_updated_at
  before update on deal_query_categories
  for each row execute function set_updated_at();

insert into deal_query_categories (name) values
  ('Docs Pending'), ('Student Not Responding'), ('Clarification Needed');

create table deal_queries (
  id             uuid primary key default gen_random_uuid(),
  deal_id        uuid not null references deals(id) on delete cascade,
  category_id    uuid not null references deal_query_categories(id),
  question       text not null,
  raised_by      uuid not null references users(id),
  status         text not null default 'Open' check (status in ('Open', 'Resolved')),
  resolution     text,
  resolved_by    uuid references users(id),
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  updated_by     uuid references users(id),
  is_deleted     boolean not null default false
);
create index idx_deal_queries_deal_id on deal_queries(deal_id);
create trigger trg_deal_queries_updated_at
  before update on deal_queries
  for each row execute function set_updated_at();

alter table deal_query_categories enable row level security;
alter table deal_query_categories force row level security;
create policy deal_query_categories_select on deal_query_categories for select using (auth.uid() is not null);
create policy deal_query_categories_write on deal_query_categories for insert with check (is_admin());
create policy deal_query_categories_update on deal_query_categories for update using (is_admin()) with check (is_admin());

alter table deal_queries enable row level security;
alter table deal_queries force row level security;
create policy deal_queries_select on deal_queries for select using (can_view_deal(deal_id));
create policy deal_queries_insert on deal_queries for insert with check (can_view_deal(deal_id) and raised_by = auth.uid());
create policy deal_queries_update on deal_queries for update using (can_view_deal(deal_id)) with check (can_view_deal(deal_id));

-- =========================================================
-- SOURCE: lender-pipeline/sql/005_lender_branches.sql
-- =========================================================

create table lender_branches (
  id          uuid primary key default gen_random_uuid(),
  lender_id   uuid not null references lenders(id),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  is_deleted  boolean not null default false,
  status      text not null default 'active',
  unique (lender_id, name)
);
create index idx_lender_branches_lender_id on lender_branches(lender_id);
create trigger trg_lender_branches_updated_at
  before update on lender_branches
  for each row execute function set_updated_at();

alter table users add column if not exists lender_branch_id uuid references lender_branches(id);
alter table invitations add column if not exists lender_organization_id uuid references lenders(id);
alter table invitations add column if not exists lender_branch_id uuid references lender_branches(id);

alter table lender_branches enable row level security;
alter table lender_branches force row level security;
create policy lender_branches_select on lender_branches for select using (auth.uid() is not null);
create policy lender_branches_write on lender_branches for insert with check (is_admin());
create policy lender_branches_update on lender_branches for update using (is_admin()) with check (is_admin());

-- Strict per-person deal access: can_view_deal() already scopes lender
-- visibility correctly (assigned_loan_officer_id / bank_rm_id) -- drop
-- the org-wide "_lender_org" policies that bypassed that scoping.
drop policy if exists deals_select_lender_org on deals;
drop policy if exists deals_update_lender_org on deals;
drop policy if exists deal_bank_prospect_details_select_lender_org on deal_bank_prospect_details;
drop policy if exists deal_bank_prospect_details_insert_lender_org on deal_bank_prospect_details;
drop policy if exists deal_bank_prospect_details_lender_org on deal_bank_prospect_details;
drop policy if exists deal_events_select_lender_org on deal_events;
drop policy if exists deal_events_insert_lender_org on deal_events;
drop policy if exists deal_login_details_lender_org_select on deal_login_details;
drop policy if exists deal_sanction_details_lender_org_select on deal_sanction_details;
drop policy if exists deal_pf_details_lender_org_select on deal_pf_details;
drop policy if exists disbursements_select_lender_org on disbursements;

-- These four tables' org-wide policy was the ONLY thing granting lender
-- write access at all -- add the correct per-person branch first.
alter policy deal_bank_prospect_details_update on deal_bank_prospect_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_login_details_write on deal_login_details with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_login_details_update on deal_login_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_sanction_details_write on deal_sanction_details with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_sanction_details_update on deal_sanction_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_pf_details_write on deal_pf_details with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_pf_details_update on deal_pf_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy disbursements_write on disbursements with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

drop policy if exists deal_login_details_lender_org_insert on deal_login_details;
drop policy if exists deal_login_details_lender_org_update on deal_login_details;
drop policy if exists deal_sanction_details_lender_org_insert on deal_sanction_details;
drop policy if exists deal_sanction_details_lender_org_update on deal_sanction_details;
drop policy if exists deal_pf_details_lender_org_insert on deal_pf_details;
drop policy if exists deal_pf_details_lender_org_update on deal_pf_details;
drop policy if exists disbursements_insert_lender_org on disbursements;

alter policy lender_deal_messages_select on lender_deal_messages using (can_view_deal(deal_id));
alter policy lender_deal_messages_insert on lender_deal_messages with check (sender_id = auth.uid() and can_view_deal(deal_id));

-- invite_user / accept_invitation / accept_my_invitation: carry the
-- lender org + branch assignment from invite through to the users row.
drop function if exists invite_user(text, text, uuid, uuid);
create or replace function invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null,
  p_lender_organization_id uuid default null,
  p_lender_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can invite users';
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, invited_by)
  values (p_email, p_full_name, p_role_id, p_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;

create or replace function accept_invitation(
  p_invitation_id uuid,
  p_new_auth_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
begin
  select * into v_invite from invitations where id = p_invitation_id and status = 'pending' for update;
  if not found then
    raise exception 'Invitation % not found or already used', p_invitation_id;
  end if;
  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'Invitation % has expired', p_invitation_id;
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, lender_organization_id, lender_branch_id, created_by)
  values (p_new_auth_user_id, v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_invite.invited_by);

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = p_new_auth_user_id
  where id = p_invitation_id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (p_new_auth_user_id, 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;

create or replace function accept_my_invitation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
  v_email text;
begin
  v_email := auth.jwt() ->> 'email';
  if v_email is null then
    raise exception 'No authenticated email found on this session';
  end if;

  select * into v_invite from invitations
  where email = v_email and status = 'pending'
  order by invited_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No pending invitation found for %', v_email;
  end if;

  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = v_invite.id;
    raise exception 'This invitation has expired — ask your admin to send a new one';
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, lender_organization_id, lender_branch_id, created_by)
  values (auth.uid(), v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_invite.invited_by)
  on conflict (id) do nothing;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
  where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (auth.uid(), 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;


-- =========================================================
-- DOCUMENT STORAGE POLICIES + CONSULTANCIES
-- storage.objects has RLS enabled by default with zero policies for the
-- lead-documents bucket unless added explicitly — without these, every
-- upload/download is silently denied regardless of the `documents` table
-- policy. Also adds the "Consultancy" lookup shown when Lead Source is
-- BD Partnership (admin-managed list + a free-text "Other" escape hatch).
-- =========================================================

create policy lead_documents_insert on storage.objects
  for insert
  with check (
    bucket_id = 'lead-documents'
    and (
      public.is_admin()
      or (public.is_manager() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_rm() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_counselor() and public.can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

create policy lead_documents_select on storage.objects
  for select
  using (
    bucket_id = 'lead-documents'
    and (
      public.is_admin()
      or (public.is_manager() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_rm() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_counselor() and public.can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

create table consultancies (
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
create trigger trg_consultancies_updated_at
  before update on consultancies
  for each row execute function set_updated_at();

alter table consultancies enable row level security;
alter table consultancies force row level security;
create policy consultancies_select on consultancies for select using (auth.uid() is not null);
create policy consultancies_insert on consultancies for insert with check (is_admin());
create policy consultancies_update on consultancies for update using (is_admin()) with check (is_admin());

alter table leads add column consultancy_id uuid references consultancies(id);
alter table leads add column consultancy_other_name text;

-- =========================================================
-- SECURITY + WORKFLOW-INTEGRITY FIXES (from live E2E QA report, 14 Jul 2026)
-- 1. announcements_select never checked auth.uid() is not null on its
--    "audience_role = 'All'" branch — any anon-key request could read
--    every company-wide announcement with zero authentication.
-- 2. change_lead_stage / change_deal_stage allowed any stage to be
--    reached from any other stage with no validation at all (a brand
--    new lead could be marked Disbursed in one click). Now blocks
--    forward jumps that skip more than one stage, and specifically
--    requires actual disbursed-deal evidence before a lead can reach
--    "Disbursed" — both with an Admin-override escape hatch requiring
--    a stated reason. Dropped/Lost remain reachable from anywhere at
--    any time since those are legitimate exit states, not process
--    completion states.
-- 3. invite_user allowed unlimited duplicate pending invitations for
--    the same email (observed: one address invited 5+ times).
-- =========================================================

alter policy announcements_select on announcements
  using (
    auth.uid() is not null
    and (is_admin() or audience_role = 'All' or audience_role = auth_role())
  );

create or replace function change_lead_stage(
  p_lead_id uuid,
  p_new_stage_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
as $$
declare
  v_old_stage_id uuid;
  v_old_stage record;
  v_new_stage record;
  v_disbursed_count int;
begin
  select current_stage_id into v_old_stage_id from leads where id = p_lead_id for update;
  if v_old_stage_id is null then
    raise exception 'Lead % not found or not visible', p_lead_id;
  end if;

  select id, name, sequence_order, is_terminal into v_old_stage from lead_stages where id = v_old_stage_id;
  select id, name, sequence_order, is_terminal into v_new_stage from lead_stages where id = p_new_stage_id;

  if v_new_stage.name = 'Disbursed' then
    select count(*) into v_disbursed_count from deals where lead_id = p_lead_id and total_disbursed_amount > 0 and is_deleted = false;
    if v_disbursed_count = 0 and not (coalesce(is_admin(), false) and p_remarks is not null and length(trim(p_remarks)) > 0) then
      raise exception 'Cannot mark this lead Disbursed — no deal for it has a disbursed amount recorded. An Admin can override this with a reason.';
    end if;
  elsif v_new_stage.name not in ('Dropped', 'Lost')
        and v_new_stage.sequence_order > v_old_stage.sequence_order + 10
        and not coalesce(is_admin(), false) then
    raise exception 'Cannot skip stages: % → % jumps past intermediate stages. An Admin can override this.', v_old_stage.name, v_new_stage.name;
  end if;

  update leads
  set current_stage_id = p_new_stage_id, last_activity_at = now(), updated_by = auth.uid()
  where id = p_lead_id;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

create or replace function change_deal_stage(
  p_deal_id uuid,
  p_new_stage_id uuid,
  p_new_status_id uuid default null,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_stage_id uuid;
  v_old_stage record;
  v_new_stage record;
begin
  select current_deal_stage_id into v_old_stage_id from deals where id = p_deal_id for update;
  if v_old_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select id, name, sequence_order into v_old_stage from deal_stages where id = v_old_stage_id;
  select id, name, sequence_order into v_new_stage from deal_stages where id = p_new_stage_id;

  if v_new_stage.sequence_order > v_old_stage.sequence_order + 10 and not coalesce(is_admin(), false) then
    raise exception 'Cannot skip stages: % → % jumps past intermediate stages. An Admin can override this.', v_old_stage.name, v_new_stage.name;
  end if;

  update deals
  set current_deal_stage_id = p_new_stage_id,
      current_stage_status_id = p_new_status_id,
      is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if v_new_stage.name = 'Bank Prospect' then
    insert into deal_bank_prospect_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'Login' then
    insert into deal_login_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'Sanction' then
    insert into deal_sanction_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'PF' then
    insert into deal_pf_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  end if;

  insert into deal_events (deal_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_deal_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

create or replace function invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null,
  p_lender_organization_id uuid default null,
  p_lender_branch_id uuid default null,
  p_team_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'Only an Admin can invite users';
  end if;

  if exists (select 1 from invitations where email = p_email and status = 'pending' and expires_at > now()) then
    raise exception 'There is already a pending invitation for %. Revoke it first if you need to resend.', p_email;
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, invited_by)
  values (p_email, p_full_name, p_role_id, p_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, p_team_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;

-- =========================================================
-- LEAD × LENDER STATUS MATRIX
-- One row per lead per active lender, tracking share status without
-- waiting for full LCF completion. Auto-seeds on lead creation and
-- backfills when a lender is (re)activated. Marking a row "Shared"
-- atomically creates the deal via share_lead_with_lender, which
-- requires the specific loan officer (deal visibility is scoped to
-- that one person, not the whole institution).
-- =========================================================

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

-- Discovered while building this feature: RMs/Managers/Counselors had no
-- RLS permission to read a Lender-role user's row at all, which silently
-- broke both the pre-existing "Share with new lender" officer picker and
-- this new function's officer validation for every non-admin.
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

-- =========================================================
-- LENDER-VISIBLE STUDENT PROFILE
-- Lenders get everything relevant to underwriting (personal/ID/address/
-- employment/academic/family/collateral/references/co-applicants/
-- documents) EXCEPT: the CRM's internal pipeline stage, the other-
-- lenders share matrix (lead_lender_status — already had no lender RLS
-- branch), and the RM team's internal logs (lead_events, tasks —
-- already had no lender RLS branch). Implemented as a single SECURITY
-- DEFINER RPC gated on can_view_deal() rather than opening the base
-- `leads` table's RLS to lenders, so a lender can never fetch
-- current_stage_id directly via their own REST call regardless of what
-- the app's UI asks for.
-- =========================================================

create or replace function get_lead_profile_for_lender(p_deal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_result jsonb;
begin
  if not (coalesce(is_lender_side(), false) and can_view_deal(p_deal_id)) then
    raise exception 'Not authorized to view this deal''s lead profile';
  end if;

  select lead_id into v_lead_id from deals where id = p_deal_id;

  select jsonb_build_object(
    'lead', (
      select to_jsonb(l) - 'current_stage_id' - 'assigned_manager_id' - 'source_user_id'
        - 'lead_source_id' - 'priority' - 'next_follow_up_at' - 'last_activity_at'
        - 'is_duplicate_flag' - 'duplicate_of_lead_id' - 'created_by' - 'updated_by'
        - 'created_at' - 'updated_at' - 'is_deleted' - 'status'
        - 'consultancy_id' - 'consultancy_other_name'
        || jsonb_build_object('assigned_rm_name', (select full_name from users where id = l.assigned_rm_id))
      from leads l where l.id = v_lead_id
    ),
    'co_applicants', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from co_applicants c where c.lead_id = v_lead_id and c.is_deleted = false),
    'university_choices', (select coalesce(jsonb_agg(to_jsonb(u) order by u.sequence_order), '[]'::jsonb) from lead_university_choices u where u.lead_id = v_lead_id and u.is_deleted = false),
    'academic', (select to_jsonb(a) from lead_academic_details a where a.lead_id = v_lead_id and a.is_deleted = false),
    'parents', (select to_jsonb(p) from lead_parent_details p where p.lead_id = v_lead_id and p.is_deleted = false),
    'collateral', (select coalesce(jsonb_agg(to_jsonb(col)), '[]'::jsonb) from lead_collateral_details col where col.lead_id = v_lead_id and col.is_deleted = false),
    'references', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from lead_references r where r.lead_id = v_lead_id and r.is_deleted = false),
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'file_name', d.file_name, 'storage_path', d.storage_path,
        'document_type', dt.name, 'verification_status', d.verification_status,
        'uploaded_at', d.uploaded_at
      )), '[]'::jsonb)
      from documents d join document_types dt on dt.id = d.document_type_id
      where d.lead_id = v_lead_id and d.is_deleted = false
    )
  ) into v_result;

  return v_result;
end;
$$;

alter policy lead_documents_select on storage.objects
  using (
    bucket_id = 'lead-documents'
    and (
      public.is_admin()
      or (public.is_manager() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_rm() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_counselor() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_lender_side() and exists (
            select 1 from deals d
            where d.lead_id = (storage.foldername(name))[1]::uuid
              and public.can_view_deal(d.id)
          ))
    )
  );

-- =========================================================
-- Associate Team Manager role + reporting hierarchy (see
-- deployment/009_associate_team_manager_role_migration.sql for the
-- standalone, fully-commented version of this patch).
-- =========================================================

-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- Adds a new "Associate Team Manager" (ATM) role that sits between
-- Manager ("Team Manager" in the user's own words) and Relationship
-- Manager in the reporting hierarchy:
--   Manager -> [0..N Associate Team Managers] -> [0..N RMs]
--   Manager -> [0..N RMs]  (RMs may still report directly to a Manager)
--
-- Mechanics:
--   1. New role row: 'Associate Team Manager'.
--   2. New helper is_associate_team_manager(), parallel to is_manager().
--   3. rm_reports_to_current_manager() becomes TRANSITIVE: it now
--      returns true both for a direct report AND for someone who
--      reports to an ATM who themselves reports to auth.uid(). This is
--      exactly right for BOTH callers that use this function:
--        - Manager caller: sees direct reports + RMs under their ATMs.
--        - ATM caller: sees only their own direct reports (the second,
--          "grandparent" clause never matches for an ATM caller, since
--          ATMs don't have their own subordinate ATMs).
--   4. can_view_lead()/can_view_deal() get an explicit ATM branch (many
--      other policies key off these two functions, so this alone
--      extends co_applicants, deals, documents, lead_academic_details,
--      lead_collateral_details, lead_parent_details, lead_references,
--      lead_university_choices, lead_events, storage.objects and
--      deal_events/deal_queries for free).
--   5. Every OTHER policy found via
--       select tablename, policyname, cmd, qual, with_check from pg_policies
--       where qual ilike '%is_manager%' or with_check ilike '%is_manager%'
--     gets an explicit, equivalently-scoped is_associate_team_manager()
--     branch (lookup/reference tables get unscoped parity with
--     is_counselor(); relationship-scoped tables get the ATM's own
--     direct-report scoping via the now-transitive
--     rm_reports_to_current_manager()).
--   6. invite_user() is opened up to Manager and Associate Team Manager,
--      each scoped to their own reporting subtree — see inline comments.
--
-- ASSUMPTION (flagged for review): Associate Team Managers get a
-- team_id like Managers do (defaulted to their inviting Manager's
-- team_id at invite time), so Team Performance rollups attribute their
-- RMs' numbers to the right team. See admin-dashboard/public/js/app.js
-- loadTeamPerformance(), which now also queries role IN ('Manager',
-- 'Associate Team Manager') when building its manager list.

-- ---------------------------------------------------------------------
-- 1. New role
-- ---------------------------------------------------------------------
insert into roles (name, description)
select 'Associate Team Manager', 'Reports to a Manager (Team Manager); manages a subset of that Manager''s Relationship Managers directly.'
where not exists (select 1 from roles where name = 'Associate Team Manager');

-- ---------------------------------------------------------------------
-- 2. Role-check helper
-- ---------------------------------------------------------------------
create or replace function public.is_associate_team_manager()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$ select auth_role() = 'Associate Team Manager' $function$;

-- ---------------------------------------------------------------------
-- 3. Make the RM->manager relationship check transitive (one extra hop
--    through an Associate Team Manager). Safe for both Manager and ATM
--    callers per the comment above.
-- ---------------------------------------------------------------------
create or replace function public.rm_reports_to_current_manager(rm_user_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from users u
    where u.id = rm_user_id
      and (
        u.reporting_manager_id = auth.uid()
        or exists (
          select 1 from users mgr
          where mgr.id = u.reporting_manager_id
            and mgr.reporting_manager_id = auth.uid()
        )
      )
  )
$function$;

-- ---------------------------------------------------------------------
-- 4. Central visibility functions get an explicit ATM branch
-- ---------------------------------------------------------------------
create or replace function public.can_view_lead(p_lead_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from leads l
    where l.id = p_lead_id
      and (
        is_admin()
        or (is_manager() and (l.assigned_manager_id = auth.uid() or rm_reports_to_current_manager(l.assigned_rm_id)))
        or (is_associate_team_manager() and rm_reports_to_current_manager(l.assigned_rm_id))
        or (is_rm() and l.assigned_rm_id = auth.uid())
        or (is_source_role() and l.source_user_id = auth.uid())
      )
  )
$function$;

create or replace function public.can_view_deal(p_deal_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from deals d
    where d.id = p_deal_id
      and (
        is_admin()
        or (is_manager() and can_view_lead(d.lead_id))
        or (is_associate_team_manager() and can_view_lead(d.lead_id))
        or (is_rm() and can_view_lead(d.lead_id))
        or (is_counselor() and d.assigned_counselor_id = auth.uid())
        or (is_lender_side() and d.assigned_loan_officer_id = auth.uid())
        or (is_lender_side() and exists (
              select 1 from deal_bank_prospect_details bpd
              where bpd.deal_id = d.id and bpd.bank_rm_id = auth.uid()
            ))
      )
  )
$function$;

-- ---------------------------------------------------------------------
-- 5. Every remaining policy that branches on is_manager() gets a
--    parallel is_associate_team_manager() branch.
-- ---------------------------------------------------------------------

-- Lookup/reference tables: unscoped parity, same shape as is_counselor().
alter policy deal_hold_reasons_select on deal_hold_reasons
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

alter policy deal_rejection_reasons_select on deal_rejection_reasons
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

alter policy deal_stage_statuses_select on deal_stage_statuses
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor() or is_lender_side());

alter policy deal_stages_select on deal_stages
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor() or is_lender_side());

alter policy document_types_select on document_types
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

alter policy lenders_select_non_consultant on lenders
  using (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor());

-- can_view_lead()-scoped write policies.
alter policy co_applicants_write on co_applicants
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy deals_insert on deals
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy documents_insert on documents
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_counselor() and can_view_lead(lead_id)));

alter policy documents_select on documents
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_counselor() and can_view_lead(lead_id)));

alter policy documents_update on documents
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)))
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_academic_details_write on lead_academic_details
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_collateral_details_write on lead_collateral_details
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_events_insert on lead_events
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_source_role() and can_view_lead(lead_id)));

alter policy lead_lender_status_select on lead_lender_status
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)) or (is_counselor() and can_view_lead(lead_id)));

alter policy lead_lender_status_update on lead_lender_status
  using (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)))
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_parent_details_write on lead_parent_details
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_references_write on lead_references
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

alter policy lead_university_choices_write on lead_university_choices
  with check (is_admin() or (is_manager() and can_view_lead(lead_id)) or (is_associate_team_manager() and can_view_lead(lead_id)) or (is_rm() and can_view_lead(lead_id)));

-- leads table itself.
alter policy leads_insert_manager on leads
  with check (is_manager() or is_associate_team_manager());

alter policy leads_select_manager on leads
  using (
    (is_manager() and ((assigned_manager_id = auth.uid()) or rm_reports_to_current_manager(assigned_rm_id)))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_rm_id))
  );

alter policy leads_update_manager on leads
  using (
    (is_manager() and ((assigned_manager_id = auth.uid()) or rm_reports_to_current_manager(assigned_rm_id)))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_rm_id))
  )
  with check (
    (is_manager() and ((assigned_manager_id = auth.uid()) or rm_reports_to_current_manager(assigned_rm_id)))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_rm_id))
  );

-- storage.objects (lead documents bucket).
alter policy lead_documents_insert on storage.objects
  with check (
    bucket_id = 'lead-documents'
    and (
      is_admin()
      or (is_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_associate_team_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_rm() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_counselor() and can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

alter policy lead_documents_select on storage.objects
  using (
    bucket_id = 'lead-documents'
    and (
      is_admin()
      or (is_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_associate_team_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_rm() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_counselor() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_lender_side() and exists (
            select 1 from deals d
            where d.lead_id = (storage.foldername(name))[1]::uuid
              and can_view_deal(d.id)
          ))
    )
  );

-- lead_assignments, tasks, user_role_events: rm_reports_to_current_manager()-scoped.
alter policy lead_assignments_insert on lead_assignments
  with check (is_admin() or is_manager() or is_associate_team_manager());

alter policy lead_assignments_select on lead_assignments
  using (
    is_admin()
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_rm() and (assigned_to_user_id = auth.uid()))
  );

alter policy tasks_insert on tasks
  with check (
    is_admin()
    or (assigned_to_user_id = auth.uid())
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

alter policy tasks_select on tasks
  using (
    is_admin()
    or (assigned_to_user_id = auth.uid())
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

alter policy user_role_events_select_manager on user_role_events
  using (
    (is_manager() and rm_reports_to_current_manager(user_id))
    or (is_associate_team_manager() and rm_reports_to_current_manager(user_id))
  );

-- users table: lender-officer lookup parity, and manager/ATM "my team" visibility.
alter policy users_select_lender_officers_for_internal_staff on users
  using (
    (is_admin() or is_manager() or is_associate_team_manager() or is_rm() or is_counselor())
    and exists (select 1 from roles r where r.id = users.role_id and r.name = 'Lender')
  );

-- Upgraded to transitive: a Manager now also sees the Associate Team
-- Managers reporting to them AND the RMs reporting to those ATMs (not
-- just their own direct reports), matching rm_reports_to_current_manager()'s
-- new transitivity.
alter policy users_select_manager_team on users
  using (is_manager() and rm_reports_to_current_manager(id));

-- New: an Associate Team Manager sees their own direct reports' user
-- rows (for assignment dropdowns etc.) — one level only, this collapses
-- to a direct reporting_manager_id = auth.uid() check for an ATM caller.
create policy users_select_atm_team on users for select
  using (is_associate_team_manager() and rm_reports_to_current_manager(id));

-- ---------------------------------------------------------------------
-- 6. invite_user(): open up to Manager and Associate Team Manager, each
--    scoped to their own reporting subtree. Admin keeps unrestricted
--    rights. Every boolean role-check is wrapped in coalesce(x, false)
--    per the "if not coalesce(is_admin(), false)" fix from earlier
--    today — `if not NULL` silently doesn't raise in Postgres.
-- ---------------------------------------------------------------------
create or replace function public.invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null::uuid,
  p_lender_organization_id uuid default null::uuid,
  p_lender_branch_id uuid default null::uuid,
  p_team_id uuid default null::uuid
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invitation_id uuid;
  v_role_name text;
  v_reporting_manager_id uuid := p_reporting_manager_id;
  v_team_id uuid := p_team_id;
begin
  select name into v_role_name from roles where id = p_role_id and is_deleted = false;
  if v_role_name is null then
    raise exception 'Unknown role';
  end if;

  if coalesce(is_admin(), false) then
    -- Admin: unrestricted, any role, any reporting structure.
    null;

  elsif coalesce(is_manager(), false) then
    if v_role_name not in ('Relationship Manager', 'Counselor', 'Business Development', 'Associate Team Manager') then
      raise exception 'Managers can only invite Relationship Managers, Counselors, Business Development staff, or Associate Team Managers';
    end if;

    if v_reporting_manager_id is null then
      v_reporting_manager_id := auth.uid();
    end if;

    if v_role_name = 'Associate Team Manager' then
      -- An ATM you invite must report directly to you.
      if v_reporting_manager_id <> auth.uid() then
        raise exception 'Associate Team Managers you invite must report directly to you';
      end if;
    else
      -- RM/Counselor/BD may report to you, or to one of your own ATMs.
      if not (
        v_reporting_manager_id = auth.uid()
        or exists (
          select 1 from users u
          join roles r on r.id = u.role_id
          where u.id = v_reporting_manager_id
            and u.reporting_manager_id = auth.uid()
            and r.name = 'Associate Team Manager'
            and u.is_deleted = false
        )
      ) then
        raise exception 'You can only invite users who will report to you or to one of your own Associate Team Managers';
      end if;
    end if;

    if v_team_id is null then
      select team_id into v_team_id from users where id = auth.uid();
    end if;

  elsif coalesce(is_associate_team_manager(), false) then
    if v_role_name not in ('Relationship Manager', 'Counselor', 'Business Development') then
      raise exception 'Associate Team Managers can only invite Relationship Managers, Counselors, or Business Development staff';
    end if;

    if v_reporting_manager_id is null then
      v_reporting_manager_id := auth.uid();
    end if;
    if v_reporting_manager_id <> auth.uid() then
      raise exception 'Associate Team Managers can only invite users who report directly to them';
    end if;

    if v_team_id is null then
      select team_id into v_team_id from users where id = auth.uid();
    end if;

  else
    raise exception 'You are not authorized to invite users';
  end if;

  if exists (select 1 from invitations where email = p_email and status = 'pending' and expires_at > now()) then
    raise exception 'There is already a pending invitation for %. Revoke it first if you need to resend.', p_email;
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, invited_by)
  values (p_email, p_full_name, p_role_id, v_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, v_team_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- Patch from deployment/010_unassigned_leads_manager_visibility_migration.sql
-- Leads sourced via consultant-portal land with BOTH assigned_rm_id and
-- assigned_manager_id NULL, which the leads_select_manager /
-- leads_update_manager policies above (line ~3349) could never match —
-- no manager could see or claim them. Add an explicit "genuinely
-- unclaimed" branch so any Manager/ATM can see and claim leads from
-- this shared intake pool; see that file for the full writeup.
-- ---------------------------------------------------------------------
alter policy leads_select_manager on leads
  using (
    (coalesce(is_manager(), false) and (
      (assigned_manager_id = auth.uid())
      or rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
    or
    (coalesce(is_associate_team_manager(), false) and (
      rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
  );

alter policy leads_update_manager on leads
  using (
    (coalesce(is_manager(), false) and (
      (assigned_manager_id = auth.uid())
      or rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
    or
    (coalesce(is_associate_team_manager(), false) and (
      rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
  )
  with check (
    (coalesce(is_manager(), false) and (
      (assigned_manager_id = auth.uid())
      or rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
    or
    (coalesce(is_associate_team_manager(), false) and (
      rm_reports_to_current_manager(assigned_rm_id)
      or (assigned_rm_id is null and assigned_manager_id is null)
    ))
  );
