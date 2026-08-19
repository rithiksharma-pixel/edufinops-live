-- =========================================================
-- 056 — Restore recompute_lead_stage()'s ratchet and guard bypass
--
-- 055 rebuilt recompute_lead_stage() from the text in 013, not realising 037
-- had already superseded it. Replacing the deployed body with the older one
-- silently dropped three things:
--
--   1. `set_config('app.stage_automation', 'on', true)` around the UPDATE.
--      leads carries a trigger that rejects a direct stage write unless that
--      setting is on. Without it every automated stage move raised
--      "Only an Admin can set a lead's stage directly", which is what the
--      team hit when sharing a deal.
--
--   2. THE RATCHET (037). Without it the automation could demote a lead
--      again — the exact regression 037 was written to prevent. Nothing was
--      actually demoted, because (1) meant the UPDATE never landed; the
--      error was noisy enough to surface the bug before it could do harm.
--
--   3. 037's corrected deal-stage map: 'PF Paid' (013 said 'PF', which
--      matches no deal_stages row, so PF deals fell to `else 30`), and
--      'Credit Decline'/'Student Decline' mapping to null instead of
--      likewise landing on 30.
--
-- This restores 037 verbatim and adds only the stage_manually_set guard that
-- 055 was for. set_lead_stage() gets the same bypass — it writes
-- current_stage_id directly and was written against the 013 body too, so it
-- would have failed the first time an Admin used it.
--
-- Idempotent: CREATE OR REPLACE, no data written.
-- =========================================================

create or replace function public.recompute_lead_stage(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_current_stage_id uuid; v_current_name text; v_lost_reason uuid;
  v_manual boolean;
  v_current_seq int;
  v_target_seq int := 10; v_deal_seq int; v_new_stage_id uuid;
begin
  select l.current_stage_id, s.name, l.lost_reason_id, s.sequence_order, l.stage_manually_set
    into v_current_stage_id, v_current_name, v_lost_reason, v_current_seq, v_manual
  from leads l left join lead_stages s on s.id = l.current_stage_id where l.id = p_lead_id;
  if not found then return; end if;
  -- Lead Lost is a manual terminal state; an Admin's hand-set stage is
  -- treated the same way.
  if v_lost_reason is not null or v_current_name = 'Lead Lost' or coalesce(v_manual, false) then
    return;
  end if;

  if exists (select 1 from lead_events e where e.lead_id = p_lead_id and e.event_type = 'Interested' and not e.is_deleted) then
    v_target_seq := greatest(v_target_seq, 20);
  end if;
  if exists (select 1 from documents d where d.lead_id = p_lead_id and not d.is_deleted) then
    v_target_seq := greatest(v_target_seq, 30);
  end if;

  select max(case ds.name
      when 'Bank Prospect' then 30 when 'Login' then 40 when 'Sanction' then 50
      when 'PF Paid' then 60 when 'Disbursement' then 70 when 'Closed Won' then 70
      when 'Credit Decline' then null when 'Student Decline' then null
      else 30 end)
    into v_deal_seq
  from deals dl join deal_stages ds on ds.id = dl.current_deal_stage_id
  where dl.lead_id = p_lead_id and not dl.is_deleted and not dl.is_rejected;
  if v_deal_seq is not null then v_target_seq := greatest(v_target_seq, v_deal_seq); end if;

  -- THE RATCHET. Everything above derives where the evidence says the lead
  -- should be; this line says the automation may raise that verdict but not
  -- lower it. v_current_seq is null only if the lead has no stage at all, in
  -- which case greatest() is skipped and the derived value stands.
  if v_current_seq is not null then
    v_target_seq := greatest(v_target_seq, v_current_seq);
  end if;

  select id into v_new_stage_id from lead_stages where sequence_order = v_target_seq and not is_deleted limit 1;
  if v_new_stage_id is null or v_new_stage_id = v_current_stage_id then return; end if;

  perform set_config('app.stage_automation', 'on', true);
  update leads set current_stage_id = v_new_stage_id, updated_at = now() where id = p_lead_id;
  perform set_config('app.stage_automation', '', true);

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_current_stage_id, v_new_stage_id, 'Auto-updated from activity', auth.uid());
end;
$function$;

-- ---------- set_lead_stage: same bypass ----------
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
  if not coalesce(public.is_admin(), false) then
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

  perform set_config('app.stage_automation', 'on', true);
  update leads
     set current_stage_id  = p_stage_id,
         stage_manually_set = true,
         updated_at        = now(),
         updated_by        = auth.uid()
   where id = p_lead_id;
  perform set_config('app.stage_automation', '', true);

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Stage Changed', v_from_stage_id, p_stage_id,
          coalesce(nullif(btrim(p_remarks), ''), 'Set manually by an Admin'), auth.uid());
end;
$function$;

revoke all on function public.set_lead_stage(uuid, uuid, text) from public, anon;
grant execute on function public.set_lead_stage(uuid, uuid, text) to authenticated;
