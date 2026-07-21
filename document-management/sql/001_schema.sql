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
  category        text not null default 'Other' check (category in ('KYC','Academics','Financials','Other')),
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
