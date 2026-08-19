-- =========================================================
-- 055 — Lead editing surface + disbursement figures
--
-- !! The recompute_lead_stage() body below is WRONG and is corrected by 056.
-- It was rebuilt from 013 without noticing 037 had superseded it, which
-- dropped the ratchet and the app.stage_automation bypass. Run 056 straight
-- after this file; do not lift this version of the function for anything.
-- The column additions and set_lead_stage's role check are fine.
--
-- Two gaps this closes:
--
-- 1. Migration 051 narrowed the UPDATE policy so Admin and Manager can edit
--    a lead, but the client never had an edit form, so the permission was
--    unreachable. The UI half ships alongside this file; the only thing
--    missing on the database side was a way for an Admin to set the stage
--    BY HAND. Every other field was already writable.
--
-- 2. leads carries login_date/sanction_date/pf_date/disbursed_date (045) but
--    no disbursed amount. The ledger lives in disbursements/deals, which is
--    right for deals that went through the pipeline — but most of the
--    imported history has no deal row at all, so there was nowhere to record
--    what was actually disbursed. This adds the same denormalised field the
--    other milestones already have.
--
-- On stage_manually_set: recompute_lead_stage() is a ratchet driven by
-- activity. Left alone it would silently undo an Admin's choice the next
-- time a document or call landed on the lead. The flag makes a hand-set
-- stage terminal in the same way lost_reason_id already is.
-- =========================================================

alter table public.leads
  add column if not exists disbursed_amount   numeric(14,2),
  add column if not exists stage_manually_set boolean not null default false;

comment on column public.leads.disbursed_amount is
  'Denormalised disbursed figure, mirroring disbursed_date. For deals that ran '
  'through the pipeline the ledger in disbursements is the source of truth; '
  'this is for imported history that has no deal row.';
comment on column public.leads.stage_manually_set is
  'An Admin set current_stage_id by hand. recompute_lead_stage() leaves the '
  'lead alone while this is true.';

create index if not exists idx_leads_disbursed_amount
  on public.leads(disbursed_amount) where disbursed_amount is not null;

-- ---------- recompute_lead_stage: honour a hand-set stage ----------
create or replace function public.recompute_lead_stage(p_lead_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_current_stage_id uuid;
  v_current_name text;
  v_lost_reason uuid;
  v_manual boolean;
  v_target_seq int := 10;               -- Lead Qualified floor
  v_deal_seq int;
  v_new_stage_id uuid;
begin
  select l.current_stage_id, s.name, l.lost_reason_id, l.stage_manually_set
    into v_current_stage_id, v_current_name, v_lost_reason, v_manual
  from leads l left join lead_stages s on s.id = l.current_stage_id
  where l.id = p_lead_id;
  if not found then return; end if;

  -- Lead Lost is a manual terminal state; never auto-move it. An Admin's
  -- hand-set stage is treated the same way.
  if v_lost_reason is not null or v_current_name = 'Lead Lost' or v_manual then
    return;
  end if;

  -- App Start: at least one "Interested" call logged.
  if exists (select 1 from lead_events e where e.lead_id = p_lead_id and e.event_type = 'Interested' and e.is_deleted = false) then
    v_target_seq := greatest(v_target_seq, 20);
  end if;

  -- Bank Prospect: any document uploaded.
  if exists (select 1 from documents d where d.lead_id = p_lead_id and d.is_deleted = false) then
    v_target_seq := greatest(v_target_seq, 30);
  end if;

  -- From Bank Prospect on: the furthest live deal, mapped to a lead stage.
  select max(case ds.name
      when 'Bank Prospect' then 30
      when 'Login'         then 40
      when 'Sanction'      then 50
      when 'PF'            then 60
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

-- ---------- set_lead_stage: Admin-only manual override ----------
-- Deliberately an RPC rather than a plain UPDATE. The stage change has to
-- write a lead_events row so the timeline shows who moved it and why, and
-- the Admin-only rule is one the client must not be trusted to enforce.
create or replace function public.set_lead_stage(
  p_lead_id  uuid,
  p_stage_id uuid,
  p_remarks  text default null
) returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_from_stage_id uuid;
  v_to_name text;
begin
  if not public.is_admin() then
    raise exception 'Only an Admin can change a lead stage.' using errcode = '42501';
  end if;

  select current_stage_id into v_from_stage_id
  from leads where id = p_lead_id and is_deleted = false;
  if not found then
    raise exception 'Lead not found.' using errcode = 'P0002';
  end if;

  select name into v_to_name from lead_stages
  where id = p_stage_id and is_deleted = false;
  if v_to_name is null then
    raise exception 'That lead stage does not exist.' using errcode = 'P0002';
  end if;

  if v_from_stage_id = p_stage_id then return; end if;

  -- Marking Lost belongs to the existing Mark-as-Lost flow, which also
  -- captures a reason. Sending it through here would leave lost_reason_id
  -- empty and the lead in a half-set state.
  if v_to_name = 'Lead Lost' then
    raise exception 'Use Mark as Lost, so the reason is recorded.' using errcode = '22023';
  end if;

  update leads
     set current_stage_id  = p_stage_id,
         stage_manually_set = true,
         updated_at        = now(),
         updated_by        = auth.uid()
   where id = p_lead_id;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_from_stage_id, p_stage_id,
          coalesce(nullif(btrim(p_remarks), ''), 'Set manually by an Admin'), auth.uid());
end;
$function$;

revoke all on function public.set_lead_stage(uuid, uuid, text) from public, anon;
grant execute on function public.set_lead_stage(uuid, uuid, text) to authenticated;
