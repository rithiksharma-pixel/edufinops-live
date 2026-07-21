-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- "Smart Views" — per-user saved filter combinations for the Lead
-- Management list, surfaced as persistent, count-badged tabs instead of
-- re-entering the same stage/source/RM/date/priority combo every time.
-- Private to the owner in this pass — no admin-shared views yet.

create table saved_views (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id),
  name            text not null,
  filters         jsonb not null default '{}'::jsonb,
  sequence_order  int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users(id),
  updated_by      uuid references users(id),
  is_deleted      boolean not null default false,
  status          text not null default 'active',
  unique (user_id, name)
);
create index idx_saved_views_user_id on saved_views(user_id);
create trigger trg_saved_views_updated_at
  before update on saved_views
  for each row execute function set_updated_at();

alter table saved_views enable row level security;
alter table saved_views force row level security;
-- Deletes are soft (is_deleted, matching every other table in this
-- schema) via the same update policy — no delete policy needed.
create policy saved_views_select on saved_views for select using (user_id = auth.uid());
create policy saved_views_insert on saved_views for insert with check (user_id = auth.uid());
create policy saved_views_update on saved_views for update using (user_id = auth.uid()) with check (user_id = auth.uid());
