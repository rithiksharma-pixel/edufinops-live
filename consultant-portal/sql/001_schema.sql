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
