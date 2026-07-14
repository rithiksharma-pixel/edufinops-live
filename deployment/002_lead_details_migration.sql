-- Run this once on an EXISTING project that was created with an earlier
-- version of the master migration. Fresh projects already get this from
-- 000_master_migration.sql.
--
-- Adds the EL Details fields (Personal ID, Loan Identification,
-- Addresses, Employment, Academic, Parents, Co-Applicant financials,
-- Collateral, References) an RM records while working a lead.

alter table leads
  add column if not exists gender text check (gender in ('Male','Female','Other')),
  add column if not exists marital_status text check (marital_status in ('Single','Married','Divorced','Widowed')),
  add column if not exists pan_number text,
  add column if not exists aadhaar_number text,
  add column if not exists passport_number text,
  add column if not exists citizenship text default 'India',

  add column if not exists degree text,
  add column if not exists admission_offer_status text check (admission_offer_status in ('Not Applied','Applied','Conditional','Finalised','Rejected')),
  add column if not exists loan_type text check (loan_type in ('Collateral','Non Collateral')),
  add column if not exists applicant_financial_status text check (applicant_financial_status in ('Employed','Not Employed','Self-Employed','Student')),
  add column if not exists english_test_waived_off boolean not null default false,
  add column if not exists aptitude_waived_off boolean not null default false,
  add column if not exists have_cosigner boolean not null default false,
  add column if not exists cosigner_relationship text,
  add column if not exists coapplicant_financial_status text,
  add column if not exists agricultural_income boolean not null default false,
  add column if not exists total_study_cost numeric(14,2),
  add column if not exists parent_alternate_number text,
  add column if not exists self_funds_available numeric(14,2),

  add column if not exists current_address text,
  add column if not exists current_city text,
  add column if not exists current_state text,
  add column if not exists current_country text,
  add column if not exists current_pincode text,
  add column if not exists permanent_address text,
  add column if not exists permanent_city text,
  add column if not exists permanent_state text,
  add column if not exists permanent_country text,
  add column if not exists permanent_pincode text,

  add column if not exists alternate_phone text,

  add column if not exists employment_status text,
  add column if not exists credit_score integer check (credit_score is null or credit_score between 300 and 900),
  add column if not exists savings_amount numeric(14,2),
  add column if not exists has_liabilities boolean not null default false,
  add column if not exists liabilities_amount numeric(14,2);

alter table co_applicants
  add column if not exists dob date,
  add column if not exists aadhaar_number text,
  add column if not exists employer_name text,
  add column if not exists designation text,
  add column if not exists monthly_net_income numeric(14,2),
  add column if not exists credit_score integer check (credit_score is null or credit_score between 300 and 900),
  add column if not exists savings_amount numeric(14,2),
  add column if not exists has_liabilities boolean not null default false,
  add column if not exists bank_name text,
  add column if not exists branch_name text,
  add column if not exists account_number text,
  add column if not exists ifsc_code text;

create table if not exists lead_university_choices (
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
create index if not exists idx_lead_university_choices_lead_id on lead_university_choices(lead_id);
create trigger trg_lead_university_choices_updated_at
  before update on lead_university_choices
  for each row execute function set_updated_at();

create table if not exists lead_academic_details (
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
create index if not exists idx_lead_academic_details_lead_id on lead_academic_details(lead_id);
create trigger trg_lead_academic_details_updated_at
  before update on lead_academic_details
  for each row execute function set_updated_at();

create table if not exists lead_parent_details (
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
create index if not exists idx_lead_parent_details_lead_id on lead_parent_details(lead_id);
create trigger trg_lead_parent_details_updated_at
  before update on lead_parent_details
  for each row execute function set_updated_at();

create table if not exists lead_collateral_details (
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
create index if not exists idx_lead_collateral_details_lead_id on lead_collateral_details(lead_id);
create trigger trg_lead_collateral_details_updated_at
  before update on lead_collateral_details
  for each row execute function set_updated_at();

create table if not exists lead_references (
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
create index if not exists idx_lead_references_lead_id on lead_references(lead_id);
create trigger trg_lead_references_updated_at
  before update on lead_references
  for each row execute function set_updated_at();

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
