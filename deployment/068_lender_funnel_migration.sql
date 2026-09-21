-- =========================================================
-- 068 - Lender funnel: every stage a case REACHED, not only where it sits
--
-- The Manager Dashboard's "By lender" table counted each case at its current
-- stage only, so "Login 339" meant "sitting at Login right now" and left out
-- every case that had logged in and moved on to Sanction, PF or
-- Disbursement. It also:
--   * had no column for Closed Won, so those cases vanished from every stage
--     while still counting in Total;
--   * summed disbursed value from Closed Won cases only, missing money
--     already disbursed on cases still at Disbursement.
--
-- lender_funnel() counts a case at every stage it has reached. "Reached" is
-- the furthest of: its current stage, any stage in its history
-- (deal_events), and the stage-detail rows it carries (a login detail row
-- means it logged in, a disbursement row means money moved). Closed Won
-- counts as having reached Disbursement. So a case declined after Sanction
-- still counts toward Login and Sanction — it did get that far — and
-- Declined is shown alongside rather than subtracted.
--
-- Security invoker: deals RLS decides whose cases are counted.
-- =========================================================

create or replace function public.lender_funnel()
returns table (
  lender_id uuid, lender_name text,
  cases bigint, reached_login bigint, reached_sanction bigint, reached_pf bigint, reached_disbursement bigint,
  open_cases bigint, declined bigint, disbursed_amount numeric
)
language sql stable set search_path = public as $function$
  with progress as (
    select id, sequence_order from deal_stages
     where not is_deleted and not is_terminal
  ),
  per_deal as (
    select d.id, d.lender_id, d.total_disbursed_amount, d.is_rejected,
           cs.name as stage_name, cs.is_terminal,
           greatest(
             case when cs.name = 'Closed Won' then 50
                  when not cs.is_terminal then cs.sequence_order else 0 end,
             coalesce((select max(p.sequence_order) from deal_events e join progress p on p.id in (e.to_stage_id, e.from_stage_id)
                        where e.deal_id = d.id and not e.is_deleted), 0),
             case when exists (select 1 from disbursements x where x.deal_id = d.id and not x.is_deleted) then 50 else 0 end,
             case when exists (select 1 from deal_pf_details x where x.deal_id = d.id) then 40 else 0 end,
             case when exists (select 1 from deal_sanction_details x where x.deal_id = d.id) then 30 else 0 end,
             case when exists (select 1 from deal_login_details x where x.deal_id = d.id) then 20 else 0 end,
             10
           ) as reached
      from deals d
      join deal_stages cs on cs.id = d.current_deal_stage_id
     where not d.is_deleted
  )
  select l.id, l.name,
         count(*),
         count(*) filter (where reached >= 20),
         count(*) filter (where reached >= 30),
         count(*) filter (where reached >= 40),
         count(*) filter (where reached >= 50),
         count(*) filter (where not is_terminal and not is_rejected),
         count(*) filter (where stage_name in ('Credit Decline', 'Student Decline') or is_rejected),
         coalesce(sum(total_disbursed_amount), 0)
    from per_deal pd
    join lenders l on l.id = pd.lender_id
   group by l.id, l.name
$function$;

revoke all on function public.lender_funnel() from public, anon;
grant execute on function public.lender_funnel() to authenticated;

-- ---------- The consultant portal's funnel needs the same milestone dates ----------
-- consultant_students() gains login/sanction/PF/disbursed dates so the portal
-- counts a student at every stage they reached (shared/js/leadFunnel.js),
-- not only where they sit now. Dates of the student's own progress only —
-- no lender, amount or internal notes, same as before.

drop function if exists public.consultant_students();
create function public.consultant_students()
returns table (
  lead_id uuid, student_name text, student_phone text, course_name text, university_name text,
  destination_country text, intake_month int, intake_year int,
  stage_name text, stage_order int, is_lost boolean,
  created_at timestamptz, last_activity_at timestamptz, submitted_by_me boolean,
  login_date date, sanction_date date, pf_date date, disbursed_date date
)
language sql stable security definer set search_path = public as $function$
  select l.id, l.student_name, l.student_phone, l.course_name, l.university_name,
         l.destination_country, l.intake_month, l.intake_year,
         s.name, s.sequence_order::int,
         coalesce(s.name = 'Lead Lost', false) or l.lost_reason_id is not null,
         l.created_at, coalesce(l.last_activity_at, l.created_at),
         coalesce(l.source_user_id = u.id, false),
         l.login_date, l.sanction_date, l.pf_date, l.disbursed_date
  from users u
  join leads l on not l.is_deleted
   and (l.source_user_id = u.id or (u.consultancy_id is not null and l.consultancy_id = u.consultancy_id))
  left join lead_stages s on s.id = l.current_stage_id
  where u.id = auth.uid() and coalesce(is_source_role(), false)
$function$;
revoke all on function public.consultant_students() from public, anon;
grant execute on function public.consultant_students() to authenticated;
