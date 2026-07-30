-- Run this once on an EXISTING project. Idempotent: table/policy creation
-- guarded with if-not-exists, send_daily_digests() is CREATE OR REPLACE.
--
-- STAGE_TAT_THRESHOLD_DAYS was a hardcoded JS const, duplicated in
-- manager-dashboard's analyticsService.js and admin-dashboard's app.js,
-- with a comment deferring it to "once there's a Settings surface for
-- it." This is that surface: one row per deal_stage, admin-editable from
-- Admin Console -> Settings, read by both dashboards instead of a const.
--
-- Seeded with the exact values the const used to hold, so flagged deals
-- don't change the moment this migration runs.
--
-- Also threads TAT breach counts into the existing daily digest — it
-- previously covered calls/tasks/milestones/follow-ups but never
-- mentioned a deal sitting past its stage's TAT, which is exactly the
-- kind of thing a digest should surface without someone going and
-- checking Needs Attention.

create table if not exists stage_tat_thresholds (
  id             uuid primary key default gen_random_uuid(),
  deal_stage_id  uuid not null unique references deal_stages(id),
  threshold_days integer not null check (threshold_days > 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  updated_by     uuid references users(id),
  is_deleted     boolean not null default false,
  status         text not null default 'active'
);
create index if not exists idx_stage_tat_thresholds_stage on stage_tat_thresholds(deal_stage_id);

drop trigger if exists trg_stage_tat_thresholds_updated_at on stage_tat_thresholds;
create trigger trg_stage_tat_thresholds_updated_at
  before update on stage_tat_thresholds
  for each row execute function set_updated_at();

alter table stage_tat_thresholds enable row level security;
alter table stage_tat_thresholds force row level security;
drop policy if exists stage_tat_thresholds_select on stage_tat_thresholds;
drop policy if exists stage_tat_thresholds_admin_write on stage_tat_thresholds;
drop policy if exists stage_tat_thresholds_admin_update on stage_tat_thresholds;
create policy stage_tat_thresholds_select on stage_tat_thresholds for select using (auth.uid() is not null);
create policy stage_tat_thresholds_admin_write on stage_tat_thresholds for insert with check (is_admin());
create policy stage_tat_thresholds_admin_update on stage_tat_thresholds for update using (is_admin()) with check (is_admin());

insert into stage_tat_thresholds (deal_stage_id, threshold_days)
select id, v.days
from deal_stages, (values
  ('Bank Prospect', 7),
  ('Login', 5),
  ('Sanction', 10),
  ('PF Paid', 5),
  ('Disbursement', 7)
) as v(stage_name, days)
where deal_stages.name = v.stage_name
on conflict (deal_stage_id) do nothing;

create or replace function send_daily_digests()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  -- Mirrors CALL_DISPOSITIONS in lead-management/services/leadService.js.
  -- "Not Interested" counts as CONNECTED: the call did get through.
  c_call_types text[] := array['Interested','In-follow up','Not Interested','Switched off','RNR','Call Back','Others'];
  c_connected  text[] := array['Interested','In-follow up','Not Interested'];
  v_since timestamptz := now() - interval '24 hours';
  v_rm record;
  v_mgr record;
  v_html text;
  v_rows text;
  v_totals record;
begin
  create temp table _rm_stats on commit drop as
  with rms as (
    select u.id, u.full_name, u.email, u.reporting_manager_id, t.name as team_name
    from users u
    join roles r on r.id = u.role_id
    left join teams t on t.id = u.team_id
    where r.name = 'Relationship Manager' and u.is_active = true and u.is_deleted = false
  ),
  calls as (
    select le.created_by as rm_id,
           count(*) as calls,
           count(*) filter (where le.event_type = any(c_connected)) as connected
    from lead_events le
    where le.event_type = any(c_call_types) and le.is_deleted = false and le.created_at > v_since
    group by 1
  ),
  tsk as (
    select assigned_to_user_id as rm_id,
           count(*) filter (where is_completed and completed_at > v_since) as tasks_done,
           count(*) filter (where not is_completed) as tasks_open,
           count(*) filter (where not is_completed and due_date < current_date) as tasks_overdue
    from tasks where is_deleted = false
    group by 1
  ),
  ld as (
    select assigned_rm_id as rm_id,
           count(*) as leads_total,
           count(*) filter (where next_follow_up_at < now()) as overdue_followups
    from leads where is_deleted = false
    group by 1
  ),
  fnl as (
    select rm_id, string_agg(name || ' ' || cnt, ' · ' order by seq) as funnel_text
    from (
      select l.assigned_rm_id as rm_id, ls.name, ls.sequence_order as seq, count(*) as cnt
      from leads l join lead_stages ls on ls.id = l.current_stage_id
      where l.is_deleted = false and ls.is_terminal = false
      group by 1, 2, 3
    ) x group by rm_id
  ),
  -- Milestones hit in the window, read from the stage detail tables so they
  -- key off assigned_rm_id rather than a display name.
  ms as (
    select l.assigned_rm_id as rm_id,
           count(*) filter (where m.kind = 'login')    as logins,
           count(*) filter (where m.kind = 'sanction') as sanctions,
           count(*) filter (where m.kind = 'pf')       as pfs
    from (
      select d.lead_id, 'login'::text as kind, dl.login_date as on_date
        from deal_login_details dl join deals d on d.id = dl.deal_id
        where dl.is_deleted = false and d.is_deleted = false and dl.login_date is not null
      union all
      select d.lead_id, 'sanction', sn.sanction_date
        from deal_sanction_details sn join deals d on d.id = sn.deal_id
        where sn.is_deleted = false and d.is_deleted = false and sn.sanction_date is not null
      union all
      select d.lead_id, 'pf', pf.pf_date
        from deal_pf_details pf join deals d on d.id = pf.deal_id
        where pf.is_deleted = false and d.is_deleted = false and pf.pf_date is not null
    ) m
    join leads l on l.id = m.lead_id
    where m.on_date >= (current_date - 1)
    group by 1
  ),
  -- TAT breach = a live (not on hold/rejected) deal that has overstayed its
  -- current stage's configured threshold. Point-in-time like tasks_open /
  -- overdue_followups above, not windowed to 24h — this describes a
  -- backlog, not something that happened in the last day. "Entered this
  -- stage at" is the latest deal_events row that moved the deal INTO its
  -- current stage, falling back to the deal's created_at, matching the
  -- client-side logic in manager-dashboard's getAttentionSummary().
  tat as (
    select l.assigned_rm_id as rm_id, count(*) as tat_breaches
    from deals d
    join leads l on l.id = d.lead_id and l.is_deleted = false
    join stage_tat_thresholds t on t.deal_stage_id = d.current_deal_stage_id and t.is_deleted = false
    where d.is_deleted = false and d.is_on_hold = false and d.is_rejected = false
      and now() - coalesce(
        (select de.created_at from deal_events de
         where de.deal_id = d.id and de.to_stage_id = d.current_deal_stage_id and de.is_deleted = false
         order by de.created_at desc limit 1),
        d.created_at
      ) > (t.threshold_days::text || ' days')::interval
    group by 1
  )
  select rms.id, rms.full_name, rms.email, rms.reporting_manager_id, rms.team_name,
         coalesce(calls.calls, 0)              as calls,
         coalesce(calls.connected, 0)          as connected,
         coalesce(tsk.tasks_done, 0)           as tasks_done,
         coalesce(tsk.tasks_open, 0)           as tasks_open,
         coalesce(tsk.tasks_overdue, 0)        as tasks_overdue,
         coalesce(ld.leads_total, 0)           as leads_total,
         coalesce(ld.overdue_followups, 0)     as overdue_followups,
         coalesce(fnl.funnel_text, 'no active leads') as funnel_text,
         coalesce(ms.logins, 0)                as logins,
         coalesce(ms.sanctions, 0)             as sanctions,
         coalesce(ms.pfs, 0)                   as pfs,
         coalesce(tat.tat_breaches, 0)         as tat_breaches
  from rms
  left join calls on calls.rm_id = rms.id
  left join tsk   on tsk.rm_id   = rms.id
  left join ld    on ld.rm_id    = rms.id
  left join fnl   on fnl.rm_id   = rms.id
  left join ms    on ms.rm_id    = rms.id
  left join tat   on tat.rm_id   = rms.id;

  -- ---------- 1. Each RM gets their own scorecard ----------
  for v_rm in select * from _rm_stats order by full_name loop
    if v_rm.email is null then continue; end if;
    v_html := format(
      '<p>Hi %s,</p><p>Your numbers for the last 24 hours:</p>'
      || '<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">'
      || '<tr><td><strong>Calls logged</strong></td><td>%s (%s connected)</td></tr>'
      || '<tr><td><strong>Tasks completed</strong></td><td>%s</td></tr>'
      || '<tr><td><strong>Tasks still open</strong></td><td>%s%s</td></tr>'
      || '<tr><td><strong>Milestones</strong></td><td>%s logins · %s sanctions · %s PF paid</td></tr>'
      || '<tr><td><strong>Overdue follow-ups</strong></td><td>%s</td></tr>'
      || '<tr><td><strong>TAT breaches</strong></td><td>%s%s</td></tr>'
      || '<tr><td><strong>Active leads</strong></td><td>%s</td></tr>'
      || '</table>'
      || '<p><strong>Your funnel:</strong><br>%s</p>',
      html_escape(v_rm.full_name),
      v_rm.calls, v_rm.connected,
      v_rm.tasks_done,
      v_rm.tasks_open,
      case when v_rm.tasks_overdue > 0 then format(' — <span style="color:#B91C1C;">%s overdue</span>', v_rm.tasks_overdue) else '' end,
      v_rm.logins, v_rm.sanctions, v_rm.pfs,
      v_rm.overdue_followups,
      v_rm.tat_breaches,
      case when v_rm.tat_breaches > 0 then format(' — <span style="color:#B91C1C;">%s past TAT</span>', v_rm.tat_breaches) else '' end,
      v_rm.leads_total,
      html_escape(v_rm.funnel_text)
    );
    perform notify_via_email(array[v_rm.email], 'Your daily numbers · Zolve Tangent', v_html);
  end loop;

  -- ---------- 2. Managers get their own team ----------
  for v_mgr in
    select u.id, u.full_name, u.email
    from users u join roles r on r.id = u.role_id
    where r.name in ('Manager','Associate Team Manager')
      and u.is_active = true and u.is_deleted = false and u.email is not null
  loop
    select string_agg(format(
             '<tr><td>%s</td><td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
             || '<td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
             || '<td align="center">%s</td><td align="center">%s</td><td align="center">%s</td></tr>',
             html_escape(full_name), calls, connected, tasks_done, tasks_overdue,
             logins, sanctions, pfs, overdue_followups, tat_breaches), '' order by calls desc, full_name)
      into v_rows
    from _rm_stats where reporting_manager_id = v_mgr.id;

    if v_rows is null then continue; end if;   -- nobody reports in

    select sum(calls) calls, sum(connected) connected, sum(tasks_done) tasks_done,
           sum(tasks_overdue) tasks_overdue, sum(logins) logins, sum(sanctions) sanctions,
           sum(pfs) pfs, sum(overdue_followups) overdue_followups, sum(leads_total) leads_total,
           sum(tat_breaches) tat_breaches
      into v_totals
    from _rm_stats where reporting_manager_id = v_mgr.id;

    perform notify_via_email(
      array[v_mgr.email],
      'Your team''s daily numbers · Zolve Tangent',
      format('<p>Hi %s,</p><p>Last 24 hours across your team — %s calls (%s connected), %s tasks completed, '
             || '%s logins / %s sanctions / %s PF paid, %s overdue follow-ups across %s active leads, '
             || '%s deals past their TAT.</p>'
             || '<table cellpadding="6" border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
             || '<tr style="background:#EEF2F7;"><th align="left">RM</th><th>Calls</th><th>Conn.</th><th>Tasks done</th>'
             || '<th>Tasks overdue</th><th>Logins</th><th>Sanctions</th><th>PF</th><th>Overdue f/u</th><th>TAT breach</th></tr>%s</table>',
        html_escape(v_mgr.full_name),
        v_totals.calls, v_totals.connected, v_totals.tasks_done,
        v_totals.logins, v_totals.sanctions, v_totals.pfs,
        v_totals.overdue_followups, v_totals.leads_total, v_totals.tat_breaches, v_rows)
    );
  end loop;

  -- ---------- 3. Admins get everything, grouped by team ----------
  select string_agg(format(
           '<tr><td>%s</td><td>%s</td><td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
           || '<td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
           || '<td align="center">%s</td><td align="center">%s</td><td align="center">%s</td></tr>',
           html_escape(coalesce(team_name, 'No team')), html_escape(full_name),
           calls, connected, tasks_done, tasks_overdue, logins, sanctions, pfs, overdue_followups, tat_breaches),
         '' order by team_name nulls last, calls desc, full_name)
    into v_rows
  from _rm_stats;

  if v_rows is not null then
    select sum(calls) calls, sum(connected) connected, sum(tasks_done) tasks_done,
           sum(tasks_overdue) tasks_overdue, sum(logins) logins, sum(sanctions) sanctions,
           sum(pfs) pfs, sum(overdue_followups) overdue_followups, sum(leads_total) leads_total,
           sum(tat_breaches) tat_breaches
      into v_totals from _rm_stats;

    for v_mgr in
      select u.full_name, u.email from users u join roles r on r.id = u.role_id
      where r.name = 'Admin' and u.is_active = true and u.is_deleted = false and u.email is not null
    loop
      perform notify_via_email(
        array[v_mgr.email],
        'Company daily numbers · Zolve Tangent',
        format('<p>Hi %s,</p><p><strong>Last 24 hours:</strong> %s calls (%s connected), %s tasks completed, '
               || '%s logins / %s sanctions / %s PF paid.<br>'
               || '<strong>Right now:</strong> %s active leads, %s overdue follow-ups, %s overdue tasks, '
               || '%s deals past their TAT, %s leads with no RM assigned.</p>'
               || '<table cellpadding="6" border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
               || '<tr style="background:#EEF2F7;"><th align="left">Team</th><th align="left">RM</th><th>Calls</th><th>Conn.</th>'
               || '<th>Tasks done</th><th>Tasks overdue</th><th>Logins</th><th>Sanctions</th><th>PF</th><th>Overdue f/u</th><th>TAT breach</th></tr>%s</table>',
          html_escape(v_mgr.full_name),
          v_totals.calls, v_totals.connected, v_totals.tasks_done,
          v_totals.logins, v_totals.sanctions, v_totals.pfs,
          v_totals.leads_total, v_totals.overdue_followups, v_totals.tasks_overdue,
          v_totals.tat_breaches,
          (select count(*) from leads where is_deleted = false and assigned_rm_id is null),
          v_rows)
      );
    end loop;
  end if;
end;
$function$;
