-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- Fixes from the live E2E QA report (14 Jul 2026):
-- 1. announcements_select leaked every "Everyone"-audience announcement
--    to unauthenticated requests with just the anon key.
-- 2. change_lead_stage / change_deal_stage had zero transition
--    validation — any lead could jump straight to Disbursed. Now blocks
--    forward skips (Admin can override with a reason) and specifically
--    requires actual disbursed-deal evidence before reaching Disbursed.
--    Dropped/Lost stay reachable from anywhere (legitimate exits).
-- 3. invite_user allowed unlimited duplicate pending invites per email.

alter policy announcements_select on announcements
  using (
    auth.uid() is not null
    and (is_admin() or audience_role = 'All' or audience_role = auth_role())
  );

create or replace function change_lead_stage(
  p_lead_id uuid,
  p_new_stage_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
as $$
declare
  v_old_stage_id uuid;
  v_old_stage record;
  v_new_stage record;
  v_disbursed_count int;
begin
  select current_stage_id into v_old_stage_id from leads where id = p_lead_id for update;
  if v_old_stage_id is null then
    raise exception 'Lead % not found or not visible', p_lead_id;
  end if;

  select id, name, sequence_order, is_terminal into v_old_stage from lead_stages where id = v_old_stage_id;
  select id, name, sequence_order, is_terminal into v_new_stage from lead_stages where id = p_new_stage_id;

  if v_new_stage.name = 'Disbursed' then
    select count(*) into v_disbursed_count from deals where lead_id = p_lead_id and total_disbursed_amount > 0 and is_deleted = false;
    if v_disbursed_count = 0 and not (coalesce(is_admin(), false) and p_remarks is not null and length(trim(p_remarks)) > 0) then
      raise exception 'Cannot mark this lead Disbursed — no deal for it has a disbursed amount recorded. An Admin can override this with a reason.';
    end if;
  elsif v_new_stage.name not in ('Dropped', 'Lost')
        and v_new_stage.sequence_order > v_old_stage.sequence_order + 10
        and not coalesce(is_admin(), false) then
    raise exception 'Cannot skip stages: % → % jumps past intermediate stages. An Admin can override this.', v_old_stage.name, v_new_stage.name;
  end if;

  update leads
  set current_stage_id = p_new_stage_id, last_activity_at = now(), updated_by = auth.uid()
  where id = p_lead_id;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

create or replace function change_deal_stage(
  p_deal_id uuid,
  p_new_stage_id uuid,
  p_new_status_id uuid default null,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_stage_id uuid;
  v_old_stage record;
  v_new_stage record;
begin
  select current_deal_stage_id into v_old_stage_id from deals where id = p_deal_id for update;
  if v_old_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select id, name, sequence_order into v_old_stage from deal_stages where id = v_old_stage_id;
  select id, name, sequence_order into v_new_stage from deal_stages where id = p_new_stage_id;

  if v_new_stage.sequence_order > v_old_stage.sequence_order + 10 and not coalesce(is_admin(), false) then
    raise exception 'Cannot skip stages: % → % jumps past intermediate stages. An Admin can override this.', v_old_stage.name, v_new_stage.name;
  end if;

  update deals
  set current_deal_stage_id = p_new_stage_id,
      current_stage_status_id = p_new_status_id,
      is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if v_new_stage.name = 'Bank Prospect' then
    insert into deal_bank_prospect_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'Login' then
    insert into deal_login_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'Sanction' then
    insert into deal_sanction_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'PF' then
    insert into deal_pf_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  end if;

  insert into deal_events (deal_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_deal_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

create or replace function invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null,
  p_lender_organization_id uuid default null,
  p_lender_branch_id uuid default null,
  p_team_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'Only an Admin can invite users';
  end if;

  if exists (select 1 from invitations where email = p_email and status = 'pending' and expires_at > now()) then
    raise exception 'There is already a pending invitation for %. Revoke it first if you need to resend.', p_email;
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, team_id, invited_by)
  values (p_email, p_full_name, p_role_id, p_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, p_team_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;
