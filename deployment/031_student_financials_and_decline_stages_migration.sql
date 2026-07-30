-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 031_student_financials_and_decline_stages).
-- Idempotent: every insert is guarded by NOT EXISTS; functions are CREATE OR REPLACE.
--
-- Two items from the review doc.
--
-- (a) Student Financials document types. That segment of the completeness
--     meter rendered "Not set up" because no document_types existed for
--     (applies_to='Student', category='Financials'). Names carry the period,
--     because "Bank Statements" alone does not tell an RM whether 1 month or
--     6 is acceptable, and that ambiguity is what sends files back from the
--     lender.
--
-- (b) Decline stages with reasons: "if someone's file got declined it should
--     be Credit Decline stage and the sub-dispositions, another would be
--     student decline". A decline is a STAGE the deal lands in; the
--     disposition records WHY.
--
--     Credit Decline  = the lender said no.
--     Student Decline = the student walked away.
--     Kept separate on purpose: a high student-decline rate is a
--     pricing/service problem, a high credit-decline rate is a profiling
--     problem, and summing them hides both.
--
--     Both are is_terminal, sequenced after Closed Won so dropdown order
--     stays Bank Prospect -> Login -> Sanction -> PF Paid -> Disbursement ->
--     Closed Won -> the two declines.

-- ---------- (a) Student Financials ----------
insert into document_types (name, applies_to, category, is_required, sequence_order)
select v.name, 'Student', 'Financials', v.req, v.seq
from (values
  ('ITR — last 2 years',              true,  10),
  ('Bank Statements — last 6 months', true,  20),
  ('Salary Slips — last 3 months',    false, 30)
) as v(name, req, seq)
where not exists (
  select 1 from document_types d
  where lower(d.name) = lower(v.name) and d.is_deleted = false
);

-- ---------- (b) Decline stages ----------
insert into deal_stages (name, sequence_order, is_terminal)
select v.name, v.seq, true
from (values ('Credit Decline', 70), ('Student Decline', 80)) as v(name, seq)
where not exists (
  select 1 from deal_stages s where s.name = v.name and s.is_deleted = false
);

-- Reasons as the stage's dispositions. is_terminal_for_stage on all of them:
-- a decline is the end of the road with that lender.
insert into deal_stage_statuses (deal_stage_id, name, sequence_order, is_terminal_for_stage)
select s.id, v.name, v.seq, true
from deal_stages s
join (values
  ('Credit Decline', 'Low CIBIL / credit history',        10),
  ('Credit Decline', 'Insufficient co-applicant income',  20),
  ('Credit Decline', 'Co-applicant profile not eligible', 30),
  ('Credit Decline', 'Collateral not acceptable',         40),
  ('Credit Decline', 'Course / university not funded',    50),
  ('Credit Decline', 'Country not funded',                60),
  ('Credit Decline', 'Existing obligations too high',     70),
  ('Credit Decline', 'Documentation not satisfactory',    80),
  ('Credit Decline', 'Bank policy',                       90),
  ('Credit Decline', 'Other',                            100),
  ('Student Decline', 'Interest rate too high',            10),
  ('Student Decline', 'Went with another lender',          20),
  ('Student Decline', 'Processing fee too high',           30),
  ('Student Decline', 'Sanction amount too low',           40),
  ('Student Decline', 'Self / family funding instead',     50),
  ('Student Decline', 'Admission deferred or cancelled',   60),
  ('Student Decline', 'Visa rejected',                     70),
  ('Student Decline', 'Turnaround too slow',               80),
  ('Student Decline', 'Unresponsive',                      90),
  ('Student Decline', 'Other',                            100)
) as v(stage, name, seq) on v.stage = s.name
where s.is_deleted = false
  and not exists (
    select 1 from deal_stage_statuses x
    where x.deal_stage_id = s.id and x.name = v.name and x.is_deleted = false
  );

-- ---------- Let a deal be declined from any stage ----------
-- The +10 skip guard stops someone fat-fingering Bank Prospect ->
-- Disbursement. A decline is not a skip, it is an exit, and it can happen at
-- any point — so terminal stages are exempt. Without this, declining an
-- early-stage deal would be blocked for non-Admins.
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
  select id, name, sequence_order, is_terminal into v_new_stage from deal_stages where id = p_new_stage_id;

  if not coalesce(v_new_stage.is_terminal, false)
     and v_new_stage.sequence_order > v_old_stage.sequence_order + 10
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

-- A declined deal must not move the LEAD's pipeline position: one lender's
-- no says nothing about a lead that may still be live with three others.
-- Mapped to null and excluded from the max — without this they would hit
-- `else 30` and drag leads backwards to Bank Prospect.
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
      when 'Bank Prospect'   then 30
      when 'Login'           then 40
      when 'Sanction'        then 50
      when 'PF Paid'         then 60
      when 'Disbursement'    then 70
      when 'Closed Won'      then 70
      when 'Credit Decline'  then null
      when 'Student Decline' then null
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
