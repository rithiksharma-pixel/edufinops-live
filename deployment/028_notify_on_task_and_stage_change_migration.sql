-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 028_notify_on_task_and_stage_change).
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.
--
-- Emails the RM when (a) someone assigns them a task, and (b) a lead or
-- deal they own changes stage.
--
-- Reuses the existing notify_via_email() -> send-notification-email path
-- that send_daily_digests(), trg_notify_on_lead_assignment and
-- trg_notify_on_deal_query already use, so there is one email path in the
-- system rather than two.
--
-- ⚠ REQUIRES A SECRET THAT IS NOT SET. notify_via_email() reads
-- `notification_secret` from Vault and sends it as the
-- x-notification-secret header; the Edge Function compares it to its
-- NOTIFICATION_SECRET env var. That env var is currently UNSET on this
-- project, so the function returns 401 and NOTHING is delivered — the
-- daily digest included. See deployment/DEPLOYMENT.md → "Email
-- notifications". These triggers start working the moment it is set; no
-- code change needed.
--
-- DESIGN NOTES
--
-- 1. Never email the person who did it. An RM moving their own lead's
--    stage already knows; mailing them turns a useful signal into noise
--    they learn to ignore. Only a change made by SOMEONE ELSE notifies.
--
-- 2. A kill switch, because bulk operations exist. The deal-history
--    importer replays hundreds of historical stage changes in one run;
--    without a switch that is hundreds of emails. Turn the relevant flag
--    off in notification_settings for the duration of an import.
--
-- 3. Email failure must never fail the write. Each trigger body wraps its
--    work in an exception handler — a bad SMTP config must not stop an RM
--    saving a task or moving a stage. notify_via_email() uses pg_net,
--    which is fire-and-forget, so it does not block either.
--
-- 4. Free text is HTML-escaped. Student names, task titles and remarks are
--    user input and land inside an HTML email body.

create table if not exists notification_settings (
  id                        boolean primary key default true check (id),
  notify_on_task_assigned   boolean not null default true,
  notify_on_stage_change    boolean not null default true,
  updated_at                timestamptz not null default now()
);
insert into notification_settings (id) values (true) on conflict (id) do nothing;

alter table notification_settings enable row level security;
drop policy if exists notification_settings_select on notification_settings;
drop policy if exists notification_settings_update on notification_settings;
create policy notification_settings_select on notification_settings for select using ((select auth.uid()) is not null);
create policy notification_settings_update on notification_settings for update using ((select is_admin())) with check ((select is_admin()));

create or replace function html_escape(p_text text)
returns text language sql immutable as $$
  select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

-- ---------- Task assigned ----------
create or replace function notify_task_assigned()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_enabled boolean;
  v_to text;
  v_assignee text;
  v_actor text;
  v_student text;
  v_html text;
begin
  select notify_on_task_assigned into v_enabled from notification_settings where id;
  if not coalesce(v_enabled, false) then return new; end if;

  if new.assigned_to_user_id is null or new.assigned_to_user_id = new.created_by then
    return new;
  end if;

  select email, full_name into v_to, v_assignee
  from users where id = new.assigned_to_user_id and is_active = true and is_deleted = false;
  if v_to is null then return new; end if;

  select full_name into v_actor from users where id = new.created_by;
  select student_name into v_student from leads where id = new.lead_id;

  v_html := format(
    '<p>Hi %s,</p><p><strong>%s</strong> assigned you a task%s.</p>'
    || '<ul><li><strong>Task:</strong> %s</li>%s%s</ul>'
    || '<p>Open RM Workspace to action it.</p>',
    html_escape(v_assignee),
    html_escape(coalesce(v_actor, 'Someone')),
    case when v_student is not null then ' on ' || html_escape(v_student) else '' end,
    html_escape(new.title),
    case when new.due_date is not null
         then format('<li><strong>Due:</strong> %s</li>', to_char(new.due_date, 'DD Mon YYYY')) else '' end,
    case when new.description is not null and new.description <> ''
         then format('<li><strong>Notes:</strong> %s</li>', html_escape(new.description)) else '' end
  );

  perform notify_via_email(array[v_to], format('New task: %s', new.title), v_html);
  return new;
exception when others then
  raise warning 'notify_task_assigned failed for task %: %', new.id, sqlerrm;
  return new;
end;
$function$;

drop trigger if exists trg_notify_task_assigned on tasks;
create trigger trg_notify_task_assigned
  after insert on tasks
  for each row execute function notify_task_assigned();

-- ---------- Lead stage changed ----------
create or replace function notify_lead_stage_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_enabled boolean;
  v_lead record;
  v_actor text;
  v_from text;
  v_to_stage text;
begin
  if new.event_type is distinct from 'Stage Changed' then return new; end if;
  select notify_on_stage_change into v_enabled from notification_settings where id;
  if not coalesce(v_enabled, false) then return new; end if;

  select l.student_name, l.assigned_rm_id, u.email, u.full_name as rm_name
    into v_lead
  from leads l left join users u on u.id = l.assigned_rm_id
  where l.id = new.lead_id;

  if v_lead.assigned_rm_id is null or v_lead.email is null then return new; end if;
  if v_lead.assigned_rm_id = new.created_by then return new; end if;

  select full_name into v_actor from users where id = new.created_by;
  select name into v_from from lead_stages where id = new.from_stage_id;
  select name into v_to_stage from lead_stages where id = new.to_stage_id;

  perform notify_via_email(
    array[v_lead.email],
    format('%s moved to %s', v_lead.student_name, coalesce(v_to_stage, 'a new stage')),
    format('<p>Hi %s,</p><p><strong>%s</strong> moved from <strong>%s</strong> to <strong>%s</strong>%s.</p>%s',
      html_escape(v_lead.rm_name),
      html_escape(v_lead.student_name),
      html_escape(coalesce(v_from, 'no stage')),
      html_escape(coalesce(v_to_stage, 'a new stage')),
      case when v_actor is not null then ' by ' || html_escape(v_actor) else '' end,
      case when new.remarks is not null and new.remarks <> ''
           then format('<p><em>%s</em></p>', html_escape(new.remarks)) else '' end)
  );
  return new;
exception when others then
  raise warning 'notify_lead_stage_change failed for lead_event %: %', new.id, sqlerrm;
  return new;
end;
$function$;

drop trigger if exists trg_notify_lead_stage_change on lead_events;
create trigger trg_notify_lead_stage_change
  after insert on lead_events
  for each row execute function notify_lead_stage_change();

-- ---------- Deal stage changed ----------
create or replace function notify_deal_stage_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_enabled boolean;
  v_info record;
  v_actor text;
  v_from text;
  v_to_stage text;
begin
  if new.event_type is distinct from 'Stage Changed' then return new; end if;
  select notify_on_stage_change into v_enabled from notification_settings where id;
  if not coalesce(v_enabled, false) then return new; end if;

  select l.student_name, l.assigned_rm_id, u.email, u.full_name as rm_name, ln.name as lender
    into v_info
  from deals d
  join leads l on l.id = d.lead_id
  left join users u on u.id = l.assigned_rm_id
  left join lenders ln on ln.id = d.lender_id
  where d.id = new.deal_id;

  if v_info.assigned_rm_id is null or v_info.email is null then return new; end if;
  if v_info.assigned_rm_id = new.created_by then return new; end if;

  select full_name into v_actor from users where id = new.created_by;
  select name into v_from from deal_stages where id = new.from_stage_id;
  select name into v_to_stage from deal_stages where id = new.to_stage_id;

  perform notify_via_email(
    array[v_info.email],
    format('%s at %s moved to %s', v_info.student_name, coalesce(v_info.lender, 'lender'), coalesce(v_to_stage, 'a new stage')),
    format('<p>Hi %s,</p><p><strong>%s</strong>''s deal with <strong>%s</strong> moved from <strong>%s</strong> to <strong>%s</strong>%s.</p>%s',
      html_escape(v_info.rm_name),
      html_escape(v_info.student_name),
      html_escape(coalesce(v_info.lender, 'the lender')),
      html_escape(coalesce(v_from, 'no stage')),
      html_escape(coalesce(v_to_stage, 'a new stage')),
      case when v_actor is not null then ' by ' || html_escape(v_actor) else '' end,
      case when new.remarks is not null and new.remarks <> ''
           then format('<p><em>%s</em></p>', html_escape(new.remarks)) else '' end)
  );
  return new;
exception when others then
  raise warning 'notify_deal_stage_change failed for deal_event %: %', new.id, sqlerrm;
  return new;
end;
$function$;

drop trigger if exists trg_notify_deal_stage_change on deal_events;
create trigger trg_notify_deal_stage_change
  after insert on deal_events
  for each row execute function notify_deal_stage_change();
