-- =========================================================
-- LEAD DETAILS EXTENSION — rich EL Details capture for RMs
-- Adds the fields from the "EL Details" reference doc that weren't
-- already covered by the original leads/co_applicants schema.
-- Reuses can_view_lead() from the core Lead Management RLS file.
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
