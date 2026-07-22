-- Run this once on an EXISTING project that predates this file.
-- =========================================================
-- SCHEMA-DRIFT CAPTURE — brings the tracked migrations back in line with
-- what's actually on the live database.
--
-- The `teams` table, the `team_id` columns (users, invitations), and the
-- `announcements` table were all added to the live DB out-of-band and were
-- never in deployment/ — yet the master migration's own RPCs read/write
-- team_id, and the Admin Console UI reads/writes both tables. A rebuild
-- from the tracked files alone would have been missing all of this.
--
-- Everything here is idempotent (IF NOT EXISTS / guarded constraint adds /
-- drop-then-create policies), so running it against the live database is a
-- safe no-op, while a fresh build finally gets a complete schema.
-- Definitions mirror the live schema exactly (columns, defaults, RLS).
-- =========================================================

-- ---------- teams ----------
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  is_deleted boolean not null default false,
  status     text not null default 'active'
);

alter table public.users        add column if not exists team_id uuid;
alter table public.invitations  add column if not exists team_id uuid;

-- Foreign keys (guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS).
do $$
begin
  if not exists (select 1 from pg_constraint where conname='teams_created_by_fkey') then
    alter table public.teams add constraint teams_created_by_fkey foreign key (created_by) references public.users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname='teams_updated_by_fkey') then
    alter table public.teams add constraint teams_updated_by_fkey foreign key (updated_by) references public.users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname='users_team_id_fkey') then
    alter table public.users add constraint users_team_id_fkey foreign key (team_id) references public.teams(id);
  end if;
  if not exists (select 1 from pg_constraint where conname='invitations_team_id_fkey') then
    alter table public.invitations add constraint invitations_team_id_fkey foreign key (team_id) references public.teams(id);
  end if;
end $$;

alter table public.teams enable row level security;
drop policy if exists teams_select on public.teams;
drop policy if exists teams_insert on public.teams;
drop policy if exists teams_update on public.teams;
create policy teams_select on public.teams for select using (auth.uid() is not null);
create policy teams_insert on public.teams for insert with check (coalesce(is_admin(), false));
create policy teams_update on public.teams for update using (coalesce(is_admin(), false)) with check (coalesce(is_admin(), false));

-- ---------- announcements ----------
create table if not exists public.announcements (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null,
  audience_role text not null default 'All',
  created_at    timestamptz not null default now(),
  created_by    uuid not null,
  is_deleted    boolean not null default false,
  status        text not null default 'active'
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='announcements_created_by_fkey') then
    alter table public.announcements add constraint announcements_created_by_fkey foreign key (created_by) references public.users(id);
  end if;
end $$;

alter table public.announcements enable row level security;
drop policy if exists announcements_select on public.announcements;
drop policy if exists announcements_insert on public.announcements;
drop policy if exists announcements_update on public.announcements;
create policy announcements_select on public.announcements for select
  using (auth.uid() is not null and (coalesce(is_admin(), false) or audience_role = 'All' or audience_role = auth_role()));
create policy announcements_insert on public.announcements for insert
  with check (coalesce(is_admin(), false) and created_by = auth.uid());
create policy announcements_update on public.announcements for update
  using (coalesce(is_admin(), false)) with check (coalesce(is_admin(), false));
