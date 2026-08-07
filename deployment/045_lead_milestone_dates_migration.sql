-- =========================================================
-- 045 — Login / Sanction / PF / Disbursement dates on the lead,
--       so they can be used as a "Date basis" in the lead list
--
-- Those dates live on the per-deal detail tables, two joins away from `leads`.
-- The lead list filters `leads` columns directly, so they could not be offered
-- as a date basis at all.
--
-- Denormalised onto the lead and kept current by trigger, rather than joined
-- at query time: it keeps the list query one flat indexed filter, and follows
-- the pattern trg_backfill_lender_onto_leads already uses.
--
-- A lead can hold several deals. The date recorded is the EARLIEST across its
-- live deals — the first time this student reached that milestone with anyone,
-- which is what "logins between X and Y" means to the business.
--
-- updated_at is deliberately NOT bumped by the recompute. These are derived
-- values; touching it would make the "Last modified" filter meaningless.
--
-- VERIFIED
--   Backfill reconciles: 347 leads with a login date from 381 source rows
--   (leads with several deals collapse to the earliest), sanction 104/105,
--   PF 72/72, disbursement 1/1.
--   Trigger, in a rolled-back transaction: set -> lead shows the date,
--   move it earlier -> lead follows, clear it -> lead goes null.
--   One lead ("test") carries login_date 0067-05-31, a typo'd year in the
--   source data. The denormalisation is faithful; the source row is wrong.
-- =========================================================

alter table public.leads
  add column if not exists login_date      date,
  add column if not exists sanction_date   date,
  add column if not exists pf_date         date,
  add column if not exists disbursed_date  date;

create index if not exists idx_leads_login_date     on public.leads(login_date);
create index if not exists idx_leads_sanction_date  on public.leads(sanction_date);
create index if not exists idx_leads_pf_date        on public.leads(pf_date);
create index if not exists idx_leads_disbursed_date on public.leads(disbursed_date);

create or replace function public.recompute_lead_milestone_dates(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update leads l
     set login_date     = m.login_date,
         sanction_date  = m.sanction_date,
         pf_date        = m.pf_date,
         disbursed_date = m.disbursed_date
    from (
      select min(dl.login_date)      as login_date,
             min(ds.sanction_date)   as sanction_date,
             min(dp.pf_date)         as pf_date,
             min(db.disbursed_date)  as disbursed_date
      from deals d
      left join deal_login_details    dl on dl.deal_id = d.id
      left join deal_sanction_details ds on ds.deal_id = d.id
      left join deal_pf_details       dp on dp.deal_id = d.id
      left join disbursements         db on db.deal_id = d.id and not db.is_deleted
      where d.lead_id = p_lead_id and not d.is_deleted
    ) m
   where l.id = p_lead_id;
end;
$function$;

create or replace function public.trg_recompute_lead_milestone_dates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lead_id uuid;
begin
  select d.lead_id into v_lead_id
    from deals d
   where d.id = coalesce(new.deal_id, old.deal_id);
  if v_lead_id is not null then
    perform recompute_lead_milestone_dates(v_lead_id);
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_lead_dates_login    on public.deal_login_details;
drop trigger if exists trg_lead_dates_sanction on public.deal_sanction_details;
drop trigger if exists trg_lead_dates_pf       on public.deal_pf_details;
drop trigger if exists trg_lead_dates_disb     on public.disbursements;

create trigger trg_lead_dates_login    after insert or update or delete on public.deal_login_details
  for each row execute function public.trg_recompute_lead_milestone_dates();
create trigger trg_lead_dates_sanction after insert or update or delete on public.deal_sanction_details
  for each row execute function public.trg_recompute_lead_milestone_dates();
create trigger trg_lead_dates_pf       after insert or update or delete on public.deal_pf_details
  for each row execute function public.trg_recompute_lead_milestone_dates();
create trigger trg_lead_dates_disb     after insert or update or delete on public.disbursements
  for each row execute function public.trg_recompute_lead_milestone_dates();

update leads l
   set login_date     = m.login_date,
       sanction_date  = m.sanction_date,
       pf_date        = m.pf_date,
       disbursed_date = m.disbursed_date
  from (
    select d.lead_id,
           min(dl.login_date)     as login_date,
           min(ds.sanction_date)  as sanction_date,
           min(dp.pf_date)        as pf_date,
           min(db.disbursed_date) as disbursed_date
    from deals d
    left join deal_login_details    dl on dl.deal_id = d.id
    left join deal_sanction_details ds on ds.deal_id = d.id
    left join deal_pf_details       dp on dp.deal_id = d.id
    left join disbursements         db on db.deal_id = d.id and not db.is_deleted
    where not d.is_deleted
    group by d.lead_id
  ) m
 where m.lead_id = l.id;


-- The funnel cards must filter on the same basis as the list, or the cards
-- and the table disagree. Everything compares as a DATE: created_at/updated_at
-- are cast down, which keeps p_date_to inclusive of the whole day exactly as
-- before, and lets the milestone columns use their new indexes.
-- An unrecognised p_date_field falls through to created_at, so the value can
-- never be used as an arbitrary column name.
create or replace function public.lead_stage_counts(
  p_source_id    uuid    default null,
  p_rm_id        uuid    default null,
  p_priority     text    default null,
  p_overdue_only boolean default false,
  p_search       text    default null,
  p_date_field   text    default 'created_at',
  p_date_from    date    default null,
  p_date_to      date    default null
)
returns table (stage_id uuid, leads bigint)
language sql
stable
set search_path to 'public'
as $function$
  select l.current_stage_id, count(*)::bigint
  from leads l
  where not l.is_deleted
    and (p_source_id is null or l.lead_source_id = p_source_id)
    and (p_rm_id     is null or l.assigned_rm_id = p_rm_id)
    and (p_priority  is null or p_priority = '' or l.priority = p_priority)
    and (not coalesce(p_overdue_only, false) or l.next_follow_up_at < now())
    and (
      p_search is null or p_search = ''
      or l.student_name  ilike '%' || p_search || '%'
      or l.student_phone ilike '%' || p_search || '%'
    )
    and (p_date_from is null or
         (case p_date_field
            when 'updated_at'     then l.updated_at::date
            when 'login_date'     then l.login_date
            when 'sanction_date'  then l.sanction_date
            when 'pf_date'        then l.pf_date
            when 'disbursed_date' then l.disbursed_date
            else l.created_at::date
          end) >= p_date_from)
    and (p_date_to is null or
         (case p_date_field
            when 'updated_at'     then l.updated_at::date
            when 'login_date'     then l.login_date
            when 'sanction_date'  then l.sanction_date
            when 'pf_date'        then l.pf_date
            when 'disbursed_date' then l.disbursed_date
            else l.created_at::date
          end) <= p_date_to)
  group by l.current_stage_id;
$function$;
