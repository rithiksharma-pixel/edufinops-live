-- =========================================================
-- 065 - Partner portals: make the lender and consultant surfaces work
--
-- Neither portal has had a real outside user yet (all four Lender/Consultant
-- accounts are test logins). Testing them as a real HDFC Credila officer
-- showed three faults a bank would hit in its first five minutes:
--
--   1. Every student name rendered as "-". The list embedded leads(...)
--      through PostgREST, and a Lender has no SELECT on leads, so the embed
--      came back null for all 643 cases.
--
--   2. Stage moves, holds, rejections and reinstatement failed on 627 of
--      those 643 cases. The deal RPCs ran as the caller, and deals_update
--      only lets a lender update a deal ASSIGNED to them personally, while
--      can_view_deal lets them SEE every unassigned deal of their bank. So
--      the case opened, and every button on it errored.
--
--   3. A bank could never record a disbursement: disbursements_write has no
--      lender clause at all, though the portal shows the form.
--
-- Fix for 2 and 3: the six deal RPCs become SECURITY DEFINER and authorise
-- explicitly with can_view_deal(). For internal staff that is no change --
-- can_view_deal is already true for every internal role (via can_view_lead's
-- is_internal_staff clause), and deal_events_insert already required it. For
-- a lender it means exactly "a case of your bank that you can open". Table
-- policies are untouched, so a lender still cannot PATCH arbitrary deal
-- columns (lender_id, lead_id) directly.
--
-- Fix for 1: lender_pipeline(), a read-only list with only the columns a
-- bank needs, instead of widening leads RLS to lenders.
--
-- Consultants: real partners are consultancies (6,993 leads carry a
-- consultancy_id), but the portal only showed leads the consultant user had
-- typed in personally. users.consultancy_id links a login to its firm, and
-- consultant_students() returns status-level fields for the firm's students
-- -- no lender, sanction, PF or internal notes.
-- =========================================================

-- ---------- 1. Deal RPCs: authorise on visibility, run as owner ----------

create or replace function public.change_deal_stage(p_deal_id uuid, p_new_stage_id uuid, p_new_status_id uuid default null, p_remarks text default null, p_allow_skip boolean default false)
returns void language plpgsql security definer set search_path = public as $function$
declare
  v_old_stage_id uuid;
  v_old_stage record;
  v_new_stage record;
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select current_deal_stage_id into v_old_stage_id from deals where id = p_deal_id for update;
  if v_old_stage_id is null then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select id, name, sequence_order into v_old_stage from deal_stages where id = v_old_stage_id;
  select id, name, sequence_order, is_terminal into v_new_stage from deal_stages where id = p_new_stage_id;
  if v_new_stage.id is null then
    raise exception 'Unknown stage';
  end if;

  -- Terminal stages (Closed Won, Credit Decline, Student Decline) are exits,
  -- reachable from anywhere, so the skip guard does not apply to them.
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

create or replace function public.put_deal_on_hold(p_deal_id uuid, p_hold_reason_id uuid, p_remarks text default null)
returns void language plpgsql security definer set search_path = public as $function$
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  update deals
  set is_on_hold = true, hold_date = now(), hold_reason_id = p_hold_reason_id,
      hold_remarks = p_remarks, updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Put On Hold', p_remarks, auth.uid(), jsonb_build_object('hold_reason_id', p_hold_reason_id));
end;
$function$;

create or replace function public.release_deal_hold(p_deal_id uuid, p_remarks text default null)
returns void language plpgsql security definer set search_path = public as $function$
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  update deals set is_on_hold = false, hold_date = null, updated_by = auth.uid() where id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by)
  values (p_deal_id, 'Hold Released', p_remarks, auth.uid());
end;
$function$;

create or replace function public.reject_deal(p_deal_id uuid, p_rejection_reason_id uuid, p_remarks text default null)
returns void language plpgsql security definer set search_path = public as $function$
declare
  v_current_stage_id uuid;
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  select current_deal_stage_id into v_current_stage_id from deals where id = p_deal_id for update;

  update deals
  set is_rejected = true, rejection_date = now(), rejection_stage_id = v_current_stage_id,
      rejection_reason_id = p_rejection_reason_id, rejection_remarks = p_remarks,
      is_on_hold = false, hold_date = null, updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, from_stage_id, remarks, created_by, metadata)
  values (p_deal_id, 'Rejected', v_current_stage_id, p_remarks, auth.uid(), jsonb_build_object('rejection_reason_id', p_rejection_reason_id));
end;
$function$;

create or replace function public.reinstate_deal(p_deal_id uuid, p_remarks text default null)
returns void language plpgsql security definer set search_path = public as $function$
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;

  update deals
  set is_rejected = false, rejection_date = null, rejection_stage_id = null,
      rejection_reason_id = null, rejection_remarks = null, updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by)
  values (p_deal_id, 'Reinstated', p_remarks, auth.uid());
end;
$function$;

create or replace function public.record_disbursement(p_deal_id uuid, p_tranche_number integer, p_amount numeric, p_disbursed_date date, p_academic_term text default null, p_remarks text default null)
returns void language plpgsql security definer set search_path = public as $function$
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Deal % not found or not visible', p_deal_id;
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Disbursed amount must be greater than zero';
  end if;
  if p_disbursed_date is null or p_disbursed_date > current_date then
    raise exception 'Enter the date the money was actually disbursed';
  end if;

  insert into disbursements (deal_id, tranche_number, amount, disbursed_date, academic_term, remarks, created_by)
  values (p_deal_id, p_tranche_number, p_amount, p_disbursed_date, p_academic_term, p_remarks, auth.uid());

  update deals
  set total_disbursed_amount = coalesce((select sum(amount) from disbursements where deal_id = p_deal_id and is_deleted = false), 0),
      final_disbursement_date = greatest(coalesce(final_disbursement_date, p_disbursed_date), p_disbursed_date),
      updated_by = auth.uid()
  where id = p_deal_id;

  insert into deal_events (deal_id, event_type, remarks, created_by, metadata)
  values (p_deal_id, 'Disbursement Recorded', p_remarks, auth.uid(), jsonb_build_object('tranche_number', p_tranche_number, 'amount', p_amount));
end;
$function$;

-- ---------- 2. Lender pipeline list ----------

create or replace function public.lender_pipeline()
returns table (
  deal_id uuid, student_name text, course_name text, university_name text,
  destination_country text, intake_month int, intake_year int,
  loan_amount_requested numeric, sanction_amount numeric, total_disbursed_amount numeric,
  stage_name text, stage_order int, is_terminal boolean,
  stage_since timestamptz, days_at_stage int, tat_days int,
  is_on_hold boolean, is_rejected boolean, open_queries int, assigned_to_me boolean
)
language sql stable security definer set search_path = public as $function$
  with me as (
    select u.id, u.lender_organization_id, coalesce(is_lender_side(), false) as lender, coalesce(is_admin(), false) as admin
    from users u where u.id = auth.uid()
  )
  select d.id, l.student_name, l.course_name, l.university_name,
         l.destination_country, l.intake_month, l.intake_year,
         l.loan_amount_requested, sd.sanction_amount, d.total_disbursed_amount,
         ds.name, ds.sequence_order::int, coalesce(ds.is_terminal, false),
         st.since, (current_date - st.since::date)::int, t.threshold_days::int,
         d.is_on_hold, d.is_rejected,
         (select count(*)::int from deal_queries q where q.deal_id = d.id and q.status = 'Open' and not q.is_deleted),
         coalesce(d.assigned_loan_officer_id = auth.uid(), false)
  from me
  join deals d on not d.is_deleted
   and ((me.lender and d.lender_id = me.lender_organization_id and can_view_deal(d.id))
        or me.admin)
  join leads l on l.id = d.lead_id
  join deal_stages ds on ds.id = d.current_deal_stage_id
  left join deal_sanction_details sd on sd.deal_id = d.id and not sd.is_deleted
  left join stage_tat_thresholds t on t.deal_stage_id = ds.id and not t.is_deleted
  cross join lateral (
    select coalesce((select max(e.created_at) from deal_events e
                      where e.deal_id = d.id and e.to_stage_id = d.current_deal_stage_id and not e.is_deleted),
                    d.created_at) as since
  ) st
  where me.lender or me.admin
$function$;

revoke all on function public.lender_pipeline() from public, anon;
grant execute on function public.lender_pipeline() to authenticated;

-- ---------- 3. Consultant linkage ----------

alter table users add column if not exists consultancy_id uuid references consultancies(id);
create index if not exists idx_users_consultancy_id on users(consultancy_id) where consultancy_id is not null;

-- A consultant must not be able to re-point their own login at a rival firm.
create or replace function public.guard_users_self_update()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  admin_only_cols text[] := array['role_id','is_active','is_deleted','lender_organization_id','lender_branch_id','consultancy_id','created_by','created_at'];
  manager_cols    text[] := array['team_id','reporting_manager_id'];
  col text;
begin
  if is_admin() then
    return new;
  end if;

  foreach col in array admin_only_cols loop
    if (to_jsonb(old) ->> col) is distinct from (to_jsonb(new) ->> col) then
      raise exception 'Only an Admin can change %', col;
    end if;
  end loop;

  if not is_admin_or_manager() then
    foreach col in array manager_cols loop
      if (to_jsonb(old) ->> col) is distinct from (to_jsonb(new) ->> col) then
        raise exception 'Only an Admin or Manager can change %', col;
      end if;
    end loop;
  end if;

  return new;
end;
$function$;

create or replace function public.is_my_consultancy_lead(p_lead_id uuid)
returns boolean language sql stable security definer set search_path = public as $function$
  select coalesce(is_source_role(), false) and exists (
    select 1 from leads l join users u on u.id = auth.uid()
    where l.id = p_lead_id and not l.is_deleted
      and (l.source_user_id = u.id or (u.consultancy_id is not null and l.consultancy_id = u.consultancy_id))
  )
$function$;

create or replace function public.consultant_students()
returns table (
  lead_id uuid, student_name text, student_phone text, course_name text, university_name text,
  destination_country text, intake_month int, intake_year int,
  stage_name text, stage_order int, is_lost boolean,
  created_at timestamptz, last_activity_at timestamptz, submitted_by_me boolean
)
language sql stable security definer set search_path = public as $function$
  select l.id, l.student_name, l.student_phone, l.course_name, l.university_name,
         l.destination_country, l.intake_month, l.intake_year,
         s.name, s.sequence_order::int,
         coalesce(s.name = 'Lead Lost', false) or l.lost_reason_id is not null,
         l.created_at, coalesce(l.last_activity_at, l.created_at),
         coalesce(l.source_user_id = u.id, false)
  from users u
  join leads l on not l.is_deleted
   and (l.source_user_id = u.id or (u.consultancy_id is not null and l.consultancy_id = u.consultancy_id))
  left join lead_stages s on s.id = l.current_stage_id
  where u.id = auth.uid() and coalesce(is_source_role(), false)
$function$;

create or replace function public.consultant_student_timeline(p_lead_id uuid)
returns table (created_at timestamptz, event_type text, stage_name text)
language sql stable security definer set search_path = public as $function$
  -- Milestones only. Call outcomes, reassignment and remarks are the RM
  -- team's working notes, not something a partner firm should read.
  select e.created_at, e.event_type, s.name
  from lead_events e
  left join lead_stages s on s.id = e.to_stage_id
  where e.lead_id = p_lead_id and not e.is_deleted
    and e.event_type in ('Lead Created', 'Stage Changed', 'Lead Lost')
    and is_my_consultancy_lead(p_lead_id)
  order by e.created_at desc
$function$;

create or replace function public.consultant_portal_context()
returns jsonb language sql stable security definer set search_path = public as $function$
  select jsonb_build_object('consultancy_id', c.id, 'consultancy_name', c.name)
  from users u left join consultancies c on c.id = u.consultancy_id
  where u.id = auth.uid()
$function$;

revoke all on function public.consultant_students() from public, anon;
revoke all on function public.consultant_student_timeline(uuid) from public, anon;
revoke all on function public.consultant_portal_context() from public, anon;
revoke all on function public.is_my_consultancy_lead(uuid) from public, anon;
grant execute on function public.consultant_students() to authenticated;
grant execute on function public.consultant_student_timeline(uuid) to authenticated;
grant execute on function public.consultant_portal_context() to authenticated;
grant execute on function public.is_my_consultancy_lead(uuid) to authenticated;

-- Messages: a firm's consultant can message about any of the firm's students,
-- not only the ones they typed in themselves.
drop policy if exists lead_messages_select on lead_messages;
create policy lead_messages_select on lead_messages for select
  using (can_view_lead(lead_id) or is_my_consultancy_lead(lead_id));

drop policy if exists lead_messages_insert on lead_messages;
create policy lead_messages_insert on lead_messages for insert
  with check ((can_view_lead(lead_id) or is_my_consultancy_lead(lead_id)) and sender_id = auth.uid());

-- ---------- 4. Students a consultant adds belong to their firm ----------
-- leads_insert_source only pins source_user_id, so a consultant could tag a
-- new student to a rival firm. For source roles the firm is stamped from the
-- login, whatever the client sent.

create or replace function public.stamp_source_consultancy()
returns trigger language plpgsql security definer set search_path = public as $function$
begin
  if coalesce(is_source_role(), false) then
    new.consultancy_id := (select consultancy_id from users where id = auth.uid());
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_stamp_source_consultancy on leads;
create trigger trg_stamp_source_consultancy before insert on leads
  for each row execute function stamp_source_consultancy();
