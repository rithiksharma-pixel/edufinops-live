-- =========================================================
-- 053 — Removing a user
--
-- Manage Users could deactivate but never remove, so people who have left
-- stay in every dropdown forever. This adds removal.
--
-- IT IS A SOFT DELETE. 115 foreign keys point at users.id -- created_by and
-- updated_by on essentially every table -- so a hard delete would either fail
-- or shred the audit trail. is_deleted is the pattern the rest of the schema
-- already uses, and every historical record keeps pointing at a real row.
--
-- A REMOVED USER MUST BE EMPTY FIRST
--   34 of 41 users currently hold leads. Removing one silently would orphan
--   its whole book, and 1,831 leads sit under a single manager. So the
--   function REFUSES while the user still has:
--     * leads assigned as RM, or
--     * leads assigned as manager, or
--     * anyone reporting to them.
--   The error names the exact counts so the UI can say what to fix. Reassign
--   with the bulk-assign tool (which writes a proper audit trail per lead),
--   then remove.
--
--   Doing the reassignment inside this function was the alternative and was
--   rejected: a single bulk UPDATE of assigned_rm_id fires
--   trg_notify_on_lead_assignment per row, which against a 1,800 lead book
--   means 1,800 notifications and a real chance of hitting the 8s statement
--   timeout half way through.
--
-- OTHER GUARDS
--   Admin only. Cannot remove yourself, and cannot remove the last active
--   Admin -- either would lock everyone out of user management.
-- =========================================================

-- 'Removed' is a new event type; the check constraint has to allow it.
alter table user_role_events drop constraint if exists user_role_events_event_type_check;
alter table user_role_events add constraint user_role_events_event_type_check
  check (event_type = any (array['Invited','Activated','Role Changed','Manager Changed',
                                 'Deactivated','Reactivated','Removed']));

create or replace function public.remove_user(
  p_target_user_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rm_leads      int;
  v_mgr_leads     int;
  v_reports       int;
  v_name          text;
  v_is_admin      boolean;
  v_active_admins int;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'Only an Admin can remove a user.';
  end if;

  if p_target_user_id = auth.uid() then
    raise exception 'You cannot remove your own account.';
  end if;

  select full_name, (r.name = 'Admin')
    into v_name, v_is_admin
  from users u join roles r on r.id = u.role_id
  where u.id = p_target_user_id and not u.is_deleted;

  if v_name is null then
    raise exception 'User not found, or already removed.';
  end if;

  -- Never leave the system without an Admin.
  if v_is_admin then
    select count(*) into v_active_admins
    from users u join roles r on r.id = u.role_id
    where r.name = 'Admin' and u.is_active and not u.is_deleted;
    if v_active_admins <= 1 then
      raise exception 'Cannot remove the last active Admin. Promote someone else first.';
    end if;
  end if;

  select count(*) into v_rm_leads  from leads where assigned_rm_id = p_target_user_id and not is_deleted;
  select count(*) into v_mgr_leads from leads where assigned_manager_id = p_target_user_id and not is_deleted;
  select count(*) into v_reports   from users where reporting_manager_id = p_target_user_id and not is_deleted;

  if v_rm_leads > 0 or v_mgr_leads > 0 or v_reports > 0 then
    raise exception
      'Cannot remove % yet: % lead(s) assigned as RM, % as manager, % person(s) reporting to them. Reassign those first.',
      v_name, v_rm_leads, v_mgr_leads, v_reports;
  end if;

  update users
     set is_deleted = true,
         is_active  = false,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_target_user_id;

  insert into user_role_events (user_id, event_type, remarks, created_by)
  values (p_target_user_id, 'Removed', p_remarks, auth.uid());
end;
$function$;

comment on function public.remove_user(uuid, text) is
  'Soft-removes a user (is_deleted). Admin only. Refuses while the user holds leads or has direct reports, and refuses on self or the last active Admin.';

-- Lets the UI show WHY a user cannot be removed yet, and disable the button
-- with a real reason rather than failing on click.
create or replace function public.user_removal_blockers()
returns table (user_id uuid, rm_leads bigint, manager_leads bigint, direct_reports bigint)
language sql
stable
set search_path to 'public'
as $function$
  select u.id,
         (select count(*) from leads l where l.assigned_rm_id = u.id and not l.is_deleted),
         (select count(*) from leads l where l.assigned_manager_id = u.id and not l.is_deleted),
         (select count(*) from users d where d.reporting_manager_id = u.id and not d.is_deleted)
  from users u
  where not u.is_deleted;
$function$;

comment on function public.user_removal_blockers() is
  'Per-user counts of what must be reassigned before remove_user() will succeed.';
