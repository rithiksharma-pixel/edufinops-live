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
