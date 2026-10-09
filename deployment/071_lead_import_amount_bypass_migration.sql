-- =========================================================
-- 071 - Backfill imports may leave the loan amount blank
--
-- guard_lead_quality() requires a loan amount on every new lead, which is
-- right for anything typed into the app: an RM always knows what the student
-- asked for. Historical sheets do not carry the figure at all, and inventing
-- one would corrupt every pipeline-value number we report.
--
-- An Admin backfill sets app.lead_import for its own transaction and the
-- amount check steps aside, leaving the column null — honestly unknown. The
-- source check and the "a lost lead needs a reason" check still apply, so a
-- backfill cannot reintroduce the two gaps 067 closed. The flag is
-- transaction local and PostgREST exposes no way for a client to set it, the
-- same pattern as app.stage_automation and app.accepting_invitation.
--
-- First used for the 910-row EL sheet (Hyderabad branch, Jul-Oct 2026):
-- 606 new leads, 299 already in the CRM by phone, 5 duplicates inside the
-- sheet itself. 16 consultancies were created; 15 sheet spellings were
-- folded into partners we already had; "Lkr Charit" was added as an alias
-- for Charith. Sheet stages map as Rejected / Not Doable -> Lead Lost
-- (Not eligible), Lost -> Lead Lost (Other), Relook / Hold -> App Start,
-- #N/A and blank -> Lead Qualified, Sanctioned -> Sanction,
-- Disbursed -> Disbursement.
-- =========================================================

create or replace function public.guard_lead_quality()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  v_lost uuid;
  v_source_ok boolean;
begin
  if tg_op = 'INSERT' then
    select coalesce(is_active and not is_deleted and name <> 'Unknown', false)
      into v_source_ok from lead_sources where id = new.lead_source_id;
    if not coalesce(v_source_ok, false) then
      raise exception 'Choose where this lead came from. Every new lead needs a lead source.'
        using errcode = 'check_violation';
    end if;
    if coalesce(new.loan_amount_requested, 0) <= 0
       and current_setting('app.lead_import', true) is distinct from 'on' then
      raise exception 'Enter the loan amount requested. It must be more than zero.'
        using errcode = 'check_violation';
    end if;
  end if;

  select id into v_lost from lead_stages where name = 'Lead Lost' and not is_deleted;
  if new.current_stage_id = v_lost and new.lost_reason_id is null
     and (tg_op = 'INSERT'
          or old.current_stage_id is distinct from new.current_stage_id
          or old.lost_reason_id is not null) then
    raise exception 'Choose a reason before marking this lead as lost.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;
