-- =========================================================
-- 049 — Cumulative funnel with conversion and TAT
--
-- The Overview card showed each stage's CURRENT OCCUPANCY, so Login read
-- 2,470 when 4,315 leads had actually logged in — the ones that went on to
-- Sanction, PF or Disbursement had left the Login bucket. That is why the
-- dashboard never matched what the team believed. "Login" now means reached
-- Login OR ANYTHING BEYOND IT, which is what the business means by the word.
--
-- "Reached" uses TWO signals, because neither alone is honest:
--   current stage    covers leads still moving through the pipeline
--   milestone date   covers leads that reached a stage and were LATER LOST.
--                    lead_stages puts Lead Lost at sequence_order 900, so a
--                    lost lead's stage says nothing about how far it got;
--                    its login_date does.
-- Reaching a later stage implies every earlier one.
--
-- Reconciled against the raw current-stage counts:
--   Login 4,315 = 2,470 + 561 + 827 + 453, plus 4 lost leads carrying a
--   login_date — exactly the leads a stage-only count would have missed.
--
-- p_basis
--   'created'  cohort — leads CREATED in the window and how far they got.
--              "How is the April–July intake doing."
--   'reached'  throughput — leads that REACHED each stage during the window.
--              "How many logins did we do this month."
--
-- TWO THINGS DELIBERATELY NOT SHOWN, because they would be wrong rather than
-- merely imprecise:
--
-- 1. Lead → Login TAT is null. created_at is the 30 July import timestamp for
--    ~10,200 leads, not when the lead arrived, so 111 leads legitimately carry
--    a login_date BEFORE their creation date. The raw average came out -1,810
--    days, dragged there by one lead whose login_date is 0067-05-31 (a typo'd
--    year, -715,557 days). The milestone-to-milestone TATs are real, because
--    both ends come from the same recorded-date source, and are guarded to a
--    0..3650 day band so one corrupt date cannot move a team average again.
--
-- 2. On the 'reached' basis, Login's conversion is null. The first three steps
--    have no date of their own so they are counted by created_at, while Login
--    onward are counted by milestone date. Those are different populations — a
--    lead created in July can log in during August — and dividing one by the
--    other produced a Login conversion of 110.7%. Sanction, PF and
--    Disbursement still compare date-to-date and stay valid.
-- =========================================================

create or replace function public.lead_funnel_summary(
  p_from  date default null,
  p_to    date default null,
  p_basis text default 'created'
)
returns table (
  stage_name        text,
  step              int,
  reached           bigint,
  conversion_pct    numeric,
  avg_days_to_reach numeric
)
language sql
stable
set search_path to 'public'
as $function$
  with scoped as (
    select l.created_at, l.login_date, l.sanction_date, l.pf_date, l.disbursed_date,
           s.sequence_order as seq, s.name as stage
    from leads l
    join lead_stages s on s.id = l.current_stage_id
    where not l.is_deleted
      and (p_basis <> 'created' or (
            (p_from is null or l.created_at::date >= p_from)
        and (p_to   is null or l.created_at::date <= p_to)))
  ),
  flagged as (
    select *,
      (p_basis <> 'reached' or ((p_from is null or login_date     >= p_from) and (p_to is null or login_date     <= p_to))) as in_win_login,
      (p_basis <> 'reached' or ((p_from is null or sanction_date  >= p_from) and (p_to is null or sanction_date  <= p_to))) as in_win_sanction,
      (p_basis <> 'reached' or ((p_from is null or pf_date        >= p_from) and (p_to is null or pf_date        <= p_to))) as in_win_pf,
      (p_basis <> 'reached' or ((p_from is null or disbursed_date >= p_from) and (p_to is null or disbursed_date <= p_to))) as in_win_disb,
      (p_basis <> 'reached' or ((p_from is null or created_at::date >= p_from) and (p_to is null or created_at::date <= p_to))) as in_win_created
    from scoped
  ),
  r as (
    select
      count(*) filter (where in_win_created and seq between 10 and 70) as qualified,
      count(*) filter (where in_win_created and seq between 20 and 70) as app_start,
      count(*) filter (where in_win_created and seq between 30 and 70) as bank_prospect,
      count(*) filter (where (seq between 40 and 70 and in_win_created) or (login_date     is not null and in_win_login))    as login,
      count(*) filter (where (seq between 50 and 70 and in_win_created) or (sanction_date  is not null and in_win_sanction)) as sanction,
      count(*) filter (where (seq between 60 and 70 and in_win_created) or (pf_date        is not null and in_win_pf))       as pf,
      count(*) filter (where (seq = 70            and in_win_created) or (disbursed_date is not null and in_win_disb))       as disb,
      avg(sanction_date  - login_date)    filter (where sanction_date  is not null and login_date    is not null
                                                   and sanction_date  - login_date    between 0 and 3650) as d_sanction,
      avg(pf_date        - sanction_date) filter (where pf_date        is not null and sanction_date is not null
                                                   and pf_date        - sanction_date between 0 and 3650) as d_pf,
      avg(disbursed_date - pf_date)       filter (where disbursed_date is not null and pf_date       is not null
                                                   and disbursed_date - pf_date       between 0 and 3650) as d_disb
    from flagged
  ),
  rows_out as (
    select 'Lead Qualified'::text as stage_name, 1 as step, qualified as reached, null::bigint as prev, null::numeric as days from r
    union all select 'App Start',    2, app_start,     qualified,     null from r
    union all select 'Bank Prospect',3, bank_prospect, app_start,     null from r
    union all select 'Login',        4, login,
                     case when p_basis = 'reached' then null else bank_prospect end, null from r
    union all select 'Sanction',     5, sanction,      login,    round(d_sanction::numeric, 1) from r
    union all select 'PF Paid',      6, pf,            sanction, round(d_pf::numeric, 1)       from r
    union all select 'Disbursement', 7, disb,          pf,       round(d_disb::numeric, 1)     from r
  )
  select stage_name, step, reached,
         case when prev is null or prev = 0 then null
              else round((reached::numeric / prev) * 100, 1) end,
         days
  from rows_out
  order by step;
$function$;
