-- Run this once on an EXISTING project that was created with an earlier
-- version of the master migration. Fresh projects already get this from
-- 000_master_migration.sql.
--
-- Adds deal_query_categories + deal_queries: structured Lender <-> RM
-- questions on a deal (e.g. "Docs Pending"), raised and resolved by
-- either side.

create table if not exists deal_query_categories (
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

insert into deal_query_categories (name)
  select * from (values ('Docs Pending'), ('Student Not Responding'), ('Clarification Needed')) as v(name)
  where not exists (select 1 from deal_query_categories);

create table if not exists deal_queries (
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
create index if not exists idx_deal_queries_deal_id on deal_queries(deal_id);
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
