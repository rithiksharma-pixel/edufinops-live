-- =========================================================
-- 037 — Stage automation may only promote, never demote
--
-- WHY THIS EXISTS
-- ---------------
-- recompute_lead_stage() derives a lead's stage from evidence (an
-- "Interested" event, an uploaded document, the furthest deal) and then
-- assigns that derived stage unconditionally. It never compared the result
-- against where the lead already was, so the function could move a lead
-- BACKWARDS.
--
-- That was survivable while every stage had evidence behind it. The 30 July
-- migration changed that: 10,200 leads were imported carrying a stage_name
-- as a plain label, with no deal, no lender and no dates behind it. Today
-- 3,689 leads sit at Login or beyond with no deal at all:
--
--     Login         2,111
--     PF Paid         664
--     Sanction        507
--     Disbursement    407
--
-- For every one of those, the derived stage is 30 (Bank Prospect) or lower.
-- So the first time an RM opens one of these leads and creates the deal that
-- was always missing, the lead is dragged from Disbursement down to Bank
-- Prospect — and the funnel silently loses it. The RM's own action makes the
-- number worse, which is the hardest kind of bug to report or notice.
--
-- WHAT CHANGES
-- ------------
-- The derived sequence is now floored at the lead's current sequence. The
-- automation can still promote on new evidence exactly as before; it can no
-- longer demote. Demotion remains available deliberately, through the
-- Admin-only manual stage change (035/036) — which writes a real timeline
-- entry naming a real person, rather than "Auto-updated from activity".
--
-- Nothing else in the function is touched: the Lead Lost early return, the
-- evidence thresholds, the app.stage_automation guard bypass and the
-- lead_events write are all carried over unchanged.
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
  v_current_seq int;
  v_target_seq int := 10; v_deal_seq int; v_new_stage_id uuid;
begin
  select l.current_stage_id, s.name, l.lost_reason_id, s.sequence_order
    into v_current_stage_id, v_current_name, v_lost_reason, v_current_seq
  from leads l left join lead_stages s on s.id = l.current_stage_id where l.id = p_lead_id;
  if not found then return; end if;
  if v_lost_reason is not null or v_current_name = 'Lead Lost' then return; end if;

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
