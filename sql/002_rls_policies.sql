-- =========================================================
-- ROW LEVEL SECURITY — AUTHENTICATION
-- =========================================================
-- Reuses is_admin()/is_manager() etc. from Lead Management's RLS file,
-- which must be applied before this one (same database, same helpers).
-- =========================================================

alter table invitations enable row level security;
alter table invitations force row level security;
alter table user_role_events enable row level security;
alter table user_role_events force row level security;

-- Only Admins manage invitations. Nobody else can even see pending
-- invites (an unaccepted invite reveals a future hire's email/role).
create policy invitations_admin_all on invitations
  for all using (is_admin()) with check (is_admin());

-- Users can see their own role-change history; Managers can see it for
-- their direct reports; Admin sees everything. Nobody can write directly
-- — only the RPC functions below insert into this table (security
-- definer), keeping the audit trail tamper-proof from the client.
create policy user_role_events_select_self on user_role_events
  for select using (user_id = auth.uid());
create policy user_role_events_select_admin on user_role_events
  for select using (is_admin());
create policy user_role_events_select_manager on user_role_events
  for select using (is_manager() and rm_reports_to_current_manager(user_id));

-- No insert/update/delete policy for any role — writes only happen
-- via SECURITY DEFINER functions (004_functions.sql), never directly.
