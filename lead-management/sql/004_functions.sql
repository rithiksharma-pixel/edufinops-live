-- =========================================================
-- RPC FUNCTIONS — atomic writes that must never leave a
-- timeline out of sync with current state.
-- =========================================================

create or replace function change_lead_stage(
  p_lead_id uuid,
  p_new_stage_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_stage_id uuid;
begin
  select current_stage_id into v_old_stage_id from leads where id = p_lead_id for update;
  if v_old_stage_id is null then
    raise exception 'Lead % not found or not visible', p_lead_id;
  end if;

  update leads
  set current_stage_id = p_new_stage_id, last_activity_at = now(), updated_by = auth.uid()
  where id = p_lead_id;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

create or replace function assign_lead(
  p_lead_id uuid,
  p_new_rm_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_rm_id uuid;
begin
  select assigned_rm_id into v_old_rm_id from leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % not found or not visible', p_lead_id;
  end if;

  update lead_assignments
  set unassigned_at = now()
  where lead_id = p_lead_id and assigned_to_user_id = v_old_rm_id and unassigned_at is null;

  update leads set assigned_rm_id = p_new_rm_id, updated_by = auth.uid() where id = p_lead_id;

  insert into lead_assignments (lead_id, assigned_to_user_id, assigned_by_user_id, reason)
  values (p_lead_id, p_new_rm_id, auth.uid(), p_reason);

  insert into lead_events (lead_id, event_type, remarks, created_by, metadata)
  values (p_lead_id, 'Reassigned', p_reason, auth.uid(), jsonb_build_object('from_rm', v_old_rm_id, 'to_rm', p_new_rm_id));
end;
$$;

-- =========================================================
-- change_deal_stage — moves a deal forward (or backward) between
-- stages. Creates a blank row in the destination stage's detail
-- table if one doesn't exist yet, so the caller can immediately
-- start filling in that stage's fields. Clears is_on_hold if the
-- deal was on hold (moving stage implies it's active again) —
-- rejection is NOT auto-cleared; that requires reinstate_deal
-- explicitly, since a rejected deal resuming is a deliberate action.
-- =========================================================
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
  v_new_stage_name text;
begin
  select current_deal_stage_id into v_old_stage_id from deals where id = p_deal_id for update;
  if v_old_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select name into v_new_stage_name from deal_stages where id = p_new_stage_id;

  update deals
  set current_deal_stage_id = p_new_stage_id,
      current_stage_status_id = p_new_status_id,
      is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if v_new_stage_name = 'Bank Prospect' then
    insert into deal_bank_prospect_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage_name = 'Login' then
    insert into deal_login_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage_name = 'Sanction' then
    insert into deal_sanction_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  elsif v_new_stage_name = 'PF' then
    insert into deal_pf_details (deal_id) values (p_deal_id)
    on conflict (deal_id) do nothing;
  end if;

  insert into deal_events (deal_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_deal_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$$;

-- =========================================================
-- put_deal_on_hold / release_deal_hold — the "On Hold (Any Stage)"
-- overlay. Deliberately does not touch current_deal_stage_id.
-- =========================================================
create or replace function put_deal_on_hold(
  p_deal_id uuid,
  p_hold_reason_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  update deals
  set is_on_hold = true,
      hold_date = now(),
      hold_reason_id = p_hold_reason_id,
      hold_remarks = p_remarks,
      updated_by = auth.uid()
  where id = p_deal_id;

  if not found then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Put On Hold', p_remarks, auth.uid(), jsonb_build_object('hold_reason_id', p_hold_reason_id));
end;
$$;

create or replace function release_deal_hold(
  p_deal_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  update deals
  set is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if not found then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  insert into deal_events (deal_id, event_type, remarks, created_by)
  values (p_deal_id, 'Hold Released', p_remarks, auth.uid());
end;
$$;

-- =========================================================
-- reject_deal / reinstate_deal — the "Rejected (Any Stage)" overlay.
-- Records which stage the deal was AT when rejected, per the diagram's
-- "Rejection Stage" field.
-- =========================================================
create or replace function reject_deal(
  p_deal_id uuid,
  p_rejection_reason_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_current_stage_id uuid;
begin
  select current_deal_stage_id into v_current_stage_id from deals where id = p_deal_id for update;
  if v_current_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  update deals
  set is_rejected = true,
      rejection_date = now(),
      rejection_stage_id = v_current_stage_id,
      rejection_reason_id = p_rejection_reason_id,
      rejection_remarks = p_remarks,
      is_on_hold = false,
      hold_date = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, from_stage_id, remarks, created_by, metadata)
  values (p_deal_id, 'Rejected', v_current_stage_id, p_remarks, auth.uid(), jsonb_build_object('rejection_reason_id', p_rejection_reason_id));
end;
$$;

create or replace function reinstate_deal(
  p_deal_id uuid,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  update deals
  set is_rejected = false,
      rejection_date = null,
      rejection_stage_id = null,
      rejection_reason_id = null,
      rejection_remarks = null,
      updated_by = auth.uid()
  where id = p_deal_id;

  if not found then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  insert into deal_events (deal_id, event_type, remarks, created_by)
  values (p_deal_id, 'Reinstated', p_remarks, auth.uid());
end;
$$;

-- =========================================================
-- record_disbursement — adds a tranche and keeps the deals-level
-- cache (total_disbursed_amount) in sync in the same transaction.
-- Moving to Closed Won is a separate, deliberate change_deal_stage
-- call — this function does not do it automatically, since "fully
-- disbursed" per the diagram is a stage-status judgment call, not
-- purely a sum-of-tranches calculation.
-- =========================================================
create or replace function record_disbursement(
  p_deal_id uuid,
  p_tranche_number integer,
  p_amount numeric,
  p_disbursed_date date,
  p_academic_term text default null,
  p_remarks text default null
)
returns void
language plpgsql
security invoker
as $$
begin
  insert into disbursements (deal_id, tranche_number, amount, disbursed_date, academic_term, remarks, created_by)
  values (p_deal_id, p_tranche_number, p_amount, p_disbursed_date, p_academic_term, p_remarks, auth.uid());

  update deals
  set total_disbursed_amount = coalesce((select sum(amount) from disbursements where deal_id = p_deal_id and is_deleted = false), 0),
      updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Disbursement Recorded', p_remarks, auth.uid(), jsonb_build_object('tranche_number', p_tranche_number, 'amount', p_amount));
end;
$$;
