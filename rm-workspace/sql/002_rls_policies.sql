-- =========================================================
-- ROW LEVEL SECURITY — RM WORKSPACE (tasks)
-- =========================================================

alter table tasks enable row level security;
alter table tasks force row level security;

create policy tasks_select on tasks
  for select using (
    is_admin()
    or assigned_to_user_id = auth.uid()
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

create policy tasks_insert on tasks
  for insert with check (
    is_admin()
    or assigned_to_user_id = auth.uid()
    or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  );

create policy tasks_update on tasks
  for update using (
    is_admin()
    or assigned_to_user_id = auth.uid()
  ) with check (
    is_admin()
    or assigned_to_user_id = auth.uid()
  );
