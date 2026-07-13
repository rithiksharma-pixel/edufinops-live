-- Announcements are delivered to a signed-in user's browser. They are
-- auditable and use the existing role helpers from the core migration.
create table announcements (
  id uuid primary key default gen_random_uuid(), title text not null check (char_length(title) between 1 and 120), body text not null check (char_length(body) between 1 and 1000), audience_role text not null default 'All', created_at timestamptz not null default now(), created_by uuid not null references users(id), is_deleted boolean not null default false, status text not null default 'active'
);
create index idx_announcements_created_at on announcements(created_at desc);
alter table announcements enable row level security;
alter table announcements force row level security;
create policy announcements_select on announcements for select using (is_admin() or audience_role = 'All' or audience_role = auth_role());
create policy announcements_insert on announcements for insert with check (is_admin() and created_by = auth.uid());
create policy announcements_update on announcements for update using (is_admin()) with check (is_admin());
