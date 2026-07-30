-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 029_daily_scorecard_digests).
-- Idempotent: CREATE OR REPLACE plus an UPDATE that is a no-op once applied.
--
-- Splits notifications into: INSTANT for task assignment only, DIGEST for
-- everything else.
--
-- Stage changes were emailing one message per change. The digest already
-- covers stage movement, and per-change mail during any bulk edit is a
-- flood, so notify_on_stage_change is switched off. The triggers stay
-- installed so it can be re-enabled from notification_settings without a
-- migration.
--
-- Three audiences, ONE pass over the data:
--
--   RM       own scorecard — calls + connect rate, tasks done/open/overdue,
--            milestones hit, overdue follow-ups, live funnel
--   Manager  per-RM table for their own reports, plus team totals
--   Admin    every RM grouped by team, org totals, unassigned-lead count
--
-- Per-RM figures are computed once into a temp table and reused for all
-- three audiences. Doing it per-email would let a Manager's totals drift
-- from the sum of their team's individual scorecards — the usual failure
-- mode when each recipient's mail runs its own queries.
--
-- Activity counts cover the last 24h. Funnel, open/overdue tasks and
-- overdue follow-ups are point-in-time: they describe a BACKLOG, so
-- windowing them to 24h would be misleading.
--
-- ⚠ Still gated on NOTIFICATION_SECRET, which is UNSET on this project —
-- see DEPLOYMENT.md → "Email notifications". Until it is set, every send
-- is rejected 401 and nothing is delivered.

update notification_settings set notify_on_stage_change = false;
alter table notification_settings alter column notify_on_stage_change set default false;

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
         coalesce(ms.pfs, 0)                   as pfs
  from rms
  left join calls on calls.rm_id = rms.id
  left join tsk   on tsk.rm_id   = rms.id
  left join ld    on ld.rm_id    = rms.id
  left join fnl   on fnl.rm_id   = rms.id
  left join ms    on ms.rm_id    = rms.id;

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
             || '<td align="center">%s</td><td align="center">%s</td></tr>',
             html_escape(full_name), calls, connected, tasks_done, tasks_overdue,
             logins, sanctions, pfs, overdue_followups), '' order by calls desc, full_name)
      into v_rows
    from _rm_stats where reporting_manager_id = v_mgr.id;

    if v_rows is null then continue; end if;   -- nobody reports in

    select sum(calls) calls, sum(connected) connected, sum(tasks_done) tasks_done,
           sum(tasks_overdue) tasks_overdue, sum(logins) logins, sum(sanctions) sanctions,
           sum(pfs) pfs, sum(overdue_followups) overdue_followups, sum(leads_total) leads_total
      into v_totals
    from _rm_stats where reporting_manager_id = v_mgr.id;

    perform notify_via_email(
      array[v_mgr.email],
      'Your team''s daily numbers · Zolve Tangent',
      format('<p>Hi %s,</p><p>Last 24 hours across your team — %s calls (%s connected), %s tasks completed, '
             || '%s logins / %s sanctions / %s PF paid, %s overdue follow-ups across %s active leads.</p>'
             || '<table cellpadding="6" border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
             || '<tr style="background:#EEF2F7;"><th align="left">RM</th><th>Calls</th><th>Conn.</th><th>Tasks done</th>'
             || '<th>Tasks overdue</th><th>Logins</th><th>Sanctions</th><th>PF</th><th>Overdue f/u</th></tr>%s</table>',
        html_escape(v_mgr.full_name),
        v_totals.calls, v_totals.connected, v_totals.tasks_done,
        v_totals.logins, v_totals.sanctions, v_totals.pfs,
        v_totals.overdue_followups, v_totals.leads_total, v_rows)
    );
  end loop;

  -- ---------- 3. Admins get everything, grouped by team ----------
  select string_agg(format(
           '<tr><td>%s</td><td>%s</td><td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
           || '<td align="center">%s</td><td align="center">%s</td><td align="center">%s</td>'
           || '<td align="center">%s</td><td align="center">%s</td></tr>',
           html_escape(coalesce(team_name, 'No team')), html_escape(full_name),
           calls, connected, tasks_done, tasks_overdue, logins, sanctions, pfs, overdue_followups),
         '' order by team_name nulls last, calls desc, full_name)
    into v_rows
  from _rm_stats;

  if v_rows is not null then
    select sum(calls) calls, sum(connected) connected, sum(tasks_done) tasks_done,
           sum(tasks_overdue) tasks_overdue, sum(logins) logins, sum(sanctions) sanctions,
           sum(pfs) pfs, sum(overdue_followups) overdue_followups, sum(leads_total) leads_total
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
               || '%s leads with no RM assigned.</p>'
               || '<table cellpadding="6" border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">'
               || '<tr style="background:#EEF2F7;"><th align="left">Team</th><th align="left">RM</th><th>Calls</th><th>Conn.</th>'
               || '<th>Tasks done</th><th>Tasks overdue</th><th>Logins</th><th>Sanctions</th><th>PF</th><th>Overdue f/u</th></tr>%s</table>',
          html_escape(v_mgr.full_name),
          v_totals.calls, v_totals.connected, v_totals.tasks_done,
          v_totals.logins, v_totals.sanctions, v_totals.pfs,
          v_totals.leads_total, v_totals.overdue_followups, v_totals.tasks_overdue,
          (select count(*) from leads where is_deleted = false and assigned_rm_id is null),
          v_rows)
      );
    end loop;
  end if;
end;
$function$;
