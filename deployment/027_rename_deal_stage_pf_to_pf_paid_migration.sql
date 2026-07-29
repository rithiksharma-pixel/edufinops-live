-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 027_rename_deal_stage_pf_to_pf_paid).
-- Safe to re-run: the UPDATE is a no-op once applied, and every function
-- and view is CREATE OR REPLACE.
--
-- Renames the deal stage "PF" to "PF Paid" so it matches the lead stage
-- for the same milestone. Two names for one thing was confusing on the
-- deal's "Advance to stage" dropdown, which offered "PF" while the lead
-- pipeline everywhere else said "PF Paid".
--
-- THE RENAME CANNOT BE DONE ALONE. Two functions match this stage by its
-- literal name and must change with it:
--
--   change_deal_stage()    creates the deal_pf_details row on arrival.
--                          Left stale, moving to PF Paid creates no detail
--                          row, and the UI's follow-up UPDATE then matches
--                          zero rows and silently discards the PF date and
--                          amount the user just typed.
--
--   recompute_lead_stage() maps deal stage -> lead pipeline position via a
--                          CASE on the name. Left stale, 'PF Paid' misses
--                          every WHEN branch and hits `else 30`, dragging
--                          the lead of every PF deal BACKWARDS to Bank
--                          Prospect and writing a bogus "Stage Changed"
--                          event for each one.
--
-- v_stage_milestones also labels this milestone with a literal, so it is
-- rebuilt here too.
--
-- No data rows need rewriting: deals reference the stage by id and
-- deal_pf_details by deal_id. Verified after applying - all 8 PF Paid
-- deals still map to lead stage PF Paid (sequence 60).

update deal_stages set name = 'PF Paid' where name = 'PF';

-- ---- change_deal_stage: only the 'PF' literal differs from before ----
create or replace function public.change_deal_stage(
  p_deal_id uuid, p_new_stage_id uuid, p_new_status_id uuid default null::uuid,
  p_remarks text default null::text, p_allow_skip boolean default false)
returns void
language plpgsql
as $function$
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

  if v_new_stage.sequence_order > v_old_stage.sequence_order + 10
     and not p_allow_skip and not coalesce(is_admin(), false) then
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
    insert into deal_bank_prospect_details (deal_id) values (p_deal_id) on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'Login' then
    insert into deal_login_details (deal_id) values (p_deal_id) on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'Sanction' then
    insert into deal_sanction_details (deal_id) values (p_deal_id) on conflict (deal_id) do nothing;
  elsif v_new_stage.name = 'PF Paid' then
    insert into deal_pf_details (deal_id) values (p_deal_id) on conflict (deal_id) do nothing;
  end if;

  insert into deal_events (deal_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_deal_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$function$;

-- ---- recompute_lead_stage: only the 'PF' literal differs from before ----
create or replace function public.recompute_lead_stage(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_current_stage_id uuid;
  v_current_name text;
  v_lost_reason uuid;
  v_target_seq int := 10;
  v_deal_seq int;
  v_new_stage_id uuid;
begin
  select l.current_stage_id, s.name, l.lost_reason_id
    into v_current_stage_id, v_current_name, v_lost_reason
  from leads l left join lead_stages s on s.id = l.current_stage_id
  where l.id = p_lead_id;
  if not found then return; end if;

  if v_lost_reason is not null or v_current_name = 'Lead Lost' then return; end if;

  if exists (select 1 from lead_events e where e.lead_id = p_lead_id and e.event_type = 'Interested' and e.is_deleted = false) then
    v_target_seq := greatest(v_target_seq, 20);
  end if;

  if exists (select 1 from documents d where d.lead_id = p_lead_id and d.is_deleted = false) then
    v_target_seq := greatest(v_target_seq, 30);
  end if;

  select max(case ds.name
      when 'Bank Prospect' then 30
      when 'Login'         then 40
      when 'Sanction'      then 50
      when 'PF Paid'       then 60
      when 'Disbursement'  then 70
      when 'Closed Won'    then 70
      else 30 end)
    into v_deal_seq
  from deals dl join deal_stages ds on ds.id = dl.current_deal_stage_id
  where dl.lead_id = p_lead_id and dl.is_deleted = false and dl.is_rejected = false;
  if v_deal_seq is not null then v_target_seq := greatest(v_target_seq, v_deal_seq); end if;

  select id into v_new_stage_id from lead_stages where sequence_order = v_target_seq and is_deleted = false limit 1;
  if v_new_stage_id is null or v_new_stage_id = v_current_stage_id then return; end if;

  update leads set current_stage_id = v_new_stage_id, updated_at = now() where id = p_lead_id;
  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_current_stage_id, v_new_stage_id, 'Auto-updated from activity', auth.uid());
end;
$function$;

-- ---- v_stage_milestones: the milestone label is a literal too ----
create or replace view v_stage_milestones
with (security_invoker = on) as
with base as (
  select d.id as deal_id, d.lead_id, l.student_name, l.student_phone,
         ln.name as lender, lb.name as lender_branch,
         rm.full_name as assigned_rm, tm.name as team,
         src.name as lead_source,
         d.is_on_hold, d.is_rejected
  from deals d
  join leads l                 on l.id = d.lead_id and l.is_deleted = false
  left join lenders ln         on ln.id = d.lender_id
  left join lender_branches lb on lb.id = d.lender_branch_id
  left join users rm           on rm.id = l.assigned_rm_id
  left join teams tm           on tm.id = rm.team_id
  left join lead_sources src   on src.id = l.lead_source_id
  where d.is_deleted = false
)
select b.*, 'Login'::text as milestone, 1 as milestone_order,
       dl.login_date as event_date, dl.login_amount as amount, dl.login_id as reference
from base b
join deal_login_details dl on dl.deal_id = b.deal_id and dl.is_deleted = false
where dl.login_date is not null
union all
select b.*, 'Sanction'::text, 2, sn.sanction_date, sn.sanction_amount, null
from base b
join deal_sanction_details sn on sn.deal_id = b.deal_id and sn.is_deleted = false
where sn.sanction_date is not null
union all
select b.*, 'PF Paid'::text, 3, pf.pf_date, pf.pf_amount, null
from base b
join deal_pf_details pf on pf.deal_id = b.deal_id and pf.is_deleted = false
where pf.pf_date is not null
union all
select b.*, 'Disbursement'::text, 4, d.final_disbursement_date, d.total_disbursed_amount, null
from base b
join deals d on d.id = b.deal_id
where d.final_disbursement_date is not null;
