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
