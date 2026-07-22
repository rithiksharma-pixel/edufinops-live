-- =========================================================
-- SECURITY FIX — closes a privilege-escalation hole in the `users`
-- table's RLS policy.
--
-- users_admin_update (migration/schema origin) reads:
--   using (is_admin() or id = auth.uid())
--   with check (is_admin() or id = auth.uid())
-- This is ROW-scoped only — it has no column restriction. Any signed-in
-- user can therefore run, from the browser:
--   supabase.from('users').update({ role_id: '<admin-role-uuid>' }).eq('id', myId)
-- and it passes RLS (id = auth.uid() is true), silently promoting
-- themselves to Admin — completely bypassing change_user_role() /
-- deactivate_user() / reactivate_user() / change_reporting_manager(),
-- which are the only intended paths for these changes and already do
-- this authorization check correctly. Those RPCs are all `security
-- definer` and re-check is_admin() internally, so they're unaffected
-- by this fix — this only closes the raw-table-write side door.
--
-- Fix: a BEFORE UPDATE trigger that blocks a non-admin from changing
-- any of the sensitive columns on their OWN row, regardless of which
-- SQL path reaches the table. Uses to_jsonb(OLD)/to_jsonb(NEW) key
-- lookups rather than NEW.<col> so this doesn't hard-fail if a column
-- in the protected list doesn't exist on a given install (e.g. team_id,
-- which is present on this project's live database but is not created
-- by any tracked migration — see the accompanying audit note).
-- =========================================================
create or replace function guard_users_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  protected_cols text[] := array['role_id', 'is_active', 'reporting_manager_id', 'lender_organization_id', 'lender_branch_id', 'team_id', 'is_deleted', 'created_by', 'created_at'];
  col text;
begin
  if is_admin() then
    return new;
  end if;

  foreach col in array protected_cols loop
    if (to_jsonb(old) ->> col) is distinct from (to_jsonb(new) ->> col) then
      raise exception 'You are not allowed to change % directly — this requires an Admin action', col;
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_guard_users_self_update on users;
create trigger trg_guard_users_self_update
  before update on users
  for each row execute function guard_users_self_update();
