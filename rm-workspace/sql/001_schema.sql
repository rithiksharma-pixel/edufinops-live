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
