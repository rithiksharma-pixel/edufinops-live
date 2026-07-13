-- =========================================================
-- AUTHENTICATION APPLICATION — SCHEMA
-- =========================================================
-- `users` and `roles` already exist (created by Lead Management as
-- provisional stubs). This application does NOT recreate them — it
-- takes ownership of their lifecycle: invites, activation, role
-- changes, deactivation. Per the platform's shared-DB philosophy,
-- this app ADDS tables on top of what already exists.
-- =========================================================

-- =========================================================
-- INVITATIONS — tracks the invite lifecycle before a user accepts
-- and gets a real auth.users row. Actual email dispatch and auth.users
-- creation happens via a Supabase Edge Function using the service_role
-- key (inviteUserByEmail) — this table is the durable record of intent,
-- not the mechanism that sends the email.
-- =========================================================
create table invitations (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null,
  full_name             text not null,
  role_id               uuid not null references roles(id),
  reporting_manager_id  uuid references users(id),
  invited_by            uuid not null references users(id),
  invited_at            timestamptz not null default now(),
  expires_at            timestamptz not null default (now() + interval '7 days'),
  accepted_at           timestamptz,
  accepted_user_id      uuid references users(id),
  revoked_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users(id),
  updated_by            uuid references users(id),
  is_deleted            boolean not null default false,
  status                text not null default 'pending'
                          check (status in ('pending','accepted','expired','revoked'))
);

create index idx_invitations_email on invitations(email);
create index idx_invitations_status on invitations(status);

create trigger trg_invitations_updated_at
  before update on invitations
  for each row execute function set_updated_at();

-- =========================================================
-- USER ROLE EVENTS — append-only audit trail for every security-
-- sensitive change to a user's account: role change, manager
-- reassignment, activation, deactivation. Same "never overwrite,
-- always create an event" principle as lead_events/deal_events.
-- =========================================================
create table user_role_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id),
  event_type          text not null
                        check (event_type in ('Invited','Activated','Role Changed','Manager Changed','Deactivated','Reactivated')),
  old_role_id         uuid references roles(id),
  new_role_id         uuid references roles(id),
  old_manager_id      uuid references users(id),
  new_manager_id      uuid references users(id),
  remarks             text,
  created_at          timestamptz not null default now(),
  created_by          uuid references users(id),
  is_deleted          boolean not null default false,
  status              text not null default 'active'
);

create index idx_user_role_events_user_id_created_at on user_role_events(user_id, created_at desc);
