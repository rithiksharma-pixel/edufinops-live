-- =========================================================
-- 066 - Branches from the reporting tree, and performance by source
--
-- TEAMS. The business runs as two branches:
--   Hyderabad - led by Julius Dsouza
--   Bangalore - led by Vikash Pandey, with Ajay Kumar and Shivam Kumar each
--               running a sub-team under him
-- The reporting tree (users.reporting_manager_id) already said exactly this,
-- but only 4 of 45 people carried a team_id, so every "by team" figure left
-- almost everyone out. Nothing ever derived team from manager.
--
-- This migration:
--   * gives teams a branch name and a lead (teams.branch, teams.lead_user_id)
--   * fills team_id for everyone in each lead's reporting subtree
--   * fixes Vikash Pandey reporting to himself (a self-loop that makes any
--     tree walk from him never terminate)
--   * retires a team whose "name" is a pasted spreadsheet of bank RMs
--   * adds trg_users_inherit_team, so a person assigned a manager joins that
--     manager's team from then on and the two cannot drift apart again
--
-- SOURCES. org_performance() returns one row per RM per lead source with the
-- same counting rules as rm_performance(): milestones counted on the lead's
-- own login/sanction/PF/disbursement dates, leads on created_at. One small
-- grain the client can roll up any way the dashboards need — by source, by
-- branch, by sub-team, by RM, or source x branch — so those views can never
-- disagree with each other.
-- =========================================================

alter table teams add column if not exists branch text;
alter table teams add column if not exists lead_user_id uuid references users(id);

-- The guard trigger authorises by auth.uid(), which is null in a migration.
-- Disabled for these data fixes only, and re-enabled below.
alter table users disable trigger trg_guard_users_self_update;

update users set reporting_manager_id = null
 where reporting_manager_id = id;

update teams set is_deleted = true, is_active = false
 where name like '%' || chr(9) || '%' and not is_deleted;

update teams
   set branch = 'Hyderabad',
       lead_user_id = (select id from users where lower(email) = 'julius.dsouza@zolve.com')
 where name = 'Hyderabad Team' and not is_deleted;

update teams
   set branch = 'Bangalore',
       lead_user_id = (select id from users where lower(email) = 'vikash.pandey@zolve.com')
 where name = 'Bangalore Team' and not is_deleted;

-- Everyone in a lead's subtree joins that lead's team, the lead included.
with recursive tree as (
  select t.id as team_id, t.lead_user_id as user_id, 0 as depth
    from teams t
   where t.lead_user_id is not null and not t.is_deleted
  union all
  select tree.team_id, u.id, tree.depth + 1
    from users u
    join tree on u.reporting_manager_id = tree.user_id
   where not u.is_deleted and tree.depth < 10
)
update users u
   set team_id = tree.team_id
  from tree
 where u.id = tree.user_id
   and u.team_id is distinct from tree.team_id;

alter table users enable trigger trg_guard_users_self_update;

-- From now on, team follows manager.
create or replace function public.inherit_team_from_manager()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  v_team uuid;
begin
  if new.reporting_manager_id is not null
     and (tg_op = 'INSERT' or new.reporting_manager_id is distinct from old.reporting_manager_id) then
    select team_id into v_team from users where id = new.reporting_manager_id;
    if v_team is not null then
      new.team_id := v_team;
    end if;
  end if;
  return new;
end;
$function$;

-- Named to sort after trg_guard_users_self_update, so the guard sees the
-- caller's own change and this derived one is applied afterwards.
drop trigger if exists trg_users_inherit_team on users;
create trigger trg_users_inherit_team
  before insert or update of reporting_manager_id on users
  for each row execute function inherit_team_from_manager();

-- ---------- Performance by RM x source ----------

create or replace function public.org_performance(p_from date default null, p_to date default null)
returns table (
  rm_id uuid, rm_name text, rm_role text,
  manager_id uuid, manager_name text,
  team_id uuid, team_name text, branch text, branch_lead_id uuid, branch_lead_name text,
  source_name text, source_category text,
  leads bigint, logins bigint, sanctions bigint, pf bigint, disbursed bigint, disbursed_amount numeric
)
language sql stable set search_path = public as $function$
  with scoped as (
    select l.created_at, l.login_date, l.sanction_date, l.pf_date, l.disbursed_date,
           u.id as rm_id, u.full_name as rm_name, r.name as rm_role,
           m.id as manager_id, m.full_name as manager_name,
           t.id as team_id, t.name as team_name, t.branch, t.lead_user_id,
           coalesce(ls.name, 'Unknown') as source_name, coalesce(ls.category, 'Unknown') as source_category,
           dd.amt
      from leads l
      left join users u on u.id = l.assigned_rm_id and not u.is_deleted
      left join roles r on r.id = u.role_id
      left join users m on m.id = u.reporting_manager_id
      left join teams t on t.id = u.team_id and not t.is_deleted
      left join lead_sources ls on ls.id = l.lead_source_id
      left join lateral (
        select coalesce(sum(d.total_disbursed_amount), 0) as amt
          from deals d where d.lead_id = l.id and not d.is_deleted
      ) dd on true
     where not l.is_deleted
  )
  select s.rm_id, coalesce(s.rm_name, '(unassigned)'), s.rm_role,
         s.manager_id, s.manager_name,
         s.team_id, s.team_name, s.branch, s.lead_user_id,
         (select full_name from users where id = s.lead_user_id),
         s.source_name, s.source_category,
         count(*) filter (where (p_from is null or s.created_at::date >= p_from) and (p_to is null or s.created_at::date <= p_to)),
         count(*) filter (where s.login_date is not null and (p_from is null or s.login_date >= p_from) and (p_to is null or s.login_date <= p_to)),
         count(*) filter (where s.sanction_date is not null and (p_from is null or s.sanction_date >= p_from) and (p_to is null or s.sanction_date <= p_to)),
         count(*) filter (where s.pf_date is not null and (p_from is null or s.pf_date >= p_from) and (p_to is null or s.pf_date <= p_to)),
         count(*) filter (where s.disbursed_date is not null and (p_from is null or s.disbursed_date >= p_from) and (p_to is null or s.disbursed_date <= p_to)),
         coalesce(sum(s.amt) filter (where s.disbursed_date is not null and (p_from is null or s.disbursed_date >= p_from) and (p_to is null or s.disbursed_date <= p_to)), 0)
    from scoped s
   group by s.rm_id, s.rm_name, s.rm_role, s.manager_id, s.manager_name, s.team_id, s.team_name,
            s.branch, s.lead_user_id, s.source_name, s.source_category
$function$;

revoke all on function public.org_performance(date, date) from public, anon;
grant execute on function public.org_performance(date, date) to authenticated;
