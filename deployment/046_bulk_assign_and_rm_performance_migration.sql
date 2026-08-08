-- =========================================================
-- 046 — Bulk lead assignment + server-side performance
--
-- assign_leads_bulk() loops the existing assign_lead() rather than doing one
-- big UPDATE, so every lead still gets its lead_assignments row and its
-- 'Reassigned' timeline event. The audit trail is identical to assigning them
-- one at a time; it is one round trip instead of 385. assign_lead() is NOT
-- security definer, so RLS still decides which leads the caller may touch.
--
-- rm_performance() replaces a client-side reduce over EVERY lead and EVERY
-- deal — two paged fetches, 24+ sequential round trips, to produce ~30 rows.
--
-- Each metric counts against its OWN date: leads by created_at, logins by
-- login_date, sanctions by sanction_date. "Logins this week" means leads that
-- logged in this week, not leads created this week that happen to have a
-- login. Overdue is a right-now measure and ignores the window.
--
-- Team and manager come from the RM's own record (team_id,
-- reporting_manager_id), so the org chart is the single source of truth.
-- A referral is any lead whose source name contains "Referral".
--
-- VERIFIED against direct queries, all three groupings identical:
--   11,707 leads / 389 logins / 84 PF / 218 referrals
--   owner 31 rows, team 3 rows, manager 5 rows — totals invariant
--   August window narrows correctly to 195 / 146 / 40 / 16
-- =========================================================

create or replace function public.assign_leads_bulk(
  p_lead_ids uuid[],
  p_new_rm_id uuid,
  p_reason text default null
)
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_count int := 0;
begin
  if not is_admin_or_manager() then
    raise exception 'Only an Admin or Manager can assign leads in bulk';
  end if;
  if p_new_rm_id is null then
    raise exception 'Choose someone to assign these leads to';
  end if;
  if p_lead_ids is null or array_length(p_lead_ids, 1) is null then
    return 0;
  end if;
  -- A guard, not a business rule: far above any real selection, and it stops a
  -- runaway loop holding locks across the whole table.
  if array_length(p_lead_ids, 1) > 500 then
    raise exception 'Assign at most 500 leads at once (got %)', array_length(p_lead_ids, 1);
  end if;

  foreach v_id in array p_lead_ids loop
    perform assign_lead(v_id, p_new_rm_id, p_reason);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.rm_performance(
  p_from     date default null,
  p_to       date default null,
  p_group_by text default 'owner'
)
returns table (
  group_id          uuid,
  group_name        text,
  leads             bigint,
  overdue           bigint,
  logins            bigint,
  sanctions         bigint,
  pf                bigint,
  disbursed         bigint,
  disbursed_amount  numeric,
  referrals         bigint,
  pf_from_referrals bigint
)
language sql
stable
set search_path to 'public'
as $function$
  with scoped as (
    select
      l.id, l.created_at, l.next_follow_up_at,
      l.login_date, l.sanction_date, l.pf_date, l.disbursed_date,
      u.id as rm_id, u.full_name as rm_name,
      t.id as team_id, t.name as team_name,
      m.id as mgr_id, m.full_name as mgr_name,
      coalesce(ls.name ilike '%referral%', false) as is_referral,
      dd.amt as disbursed_amt
    from leads l
    join users u on u.id = l.assigned_rm_id and not u.is_deleted
    left join teams t on t.id = u.team_id
    left join users m on m.id = u.reporting_manager_id
    left join lead_sources ls on ls.id = l.lead_source_id
    left join lateral (
      select coalesce(sum(d.total_disbursed_amount), 0) as amt
      from deals d where d.lead_id = l.id and not d.is_deleted
    ) dd on true
    where not l.is_deleted
  )
  select
    case p_group_by when 'team' then s.team_id when 'manager' then s.mgr_id else s.rm_id end,
    case p_group_by
      when 'team'    then coalesce(s.team_name, '(no team)')
      when 'manager' then coalesce(s.mgr_name, '(no manager)')
      else s.rm_name
    end,
    count(*) filter (where (p_from is null or s.created_at::date >= p_from)
                       and (p_to   is null or s.created_at::date <= p_to))::bigint,
    count(*) filter (where s.next_follow_up_at < now())::bigint,
    count(*) filter (where s.login_date is not null
                       and (p_from is null or s.login_date >= p_from)
                       and (p_to   is null or s.login_date <= p_to))::bigint,
    count(*) filter (where s.sanction_date is not null
                       and (p_from is null or s.sanction_date >= p_from)
                       and (p_to   is null or s.sanction_date <= p_to))::bigint,
    count(*) filter (where s.pf_date is not null
                       and (p_from is null or s.pf_date >= p_from)
                       and (p_to   is null or s.pf_date <= p_to))::bigint,
    count(*) filter (where s.disbursed_date is not null
                       and (p_from is null or s.disbursed_date >= p_from)
                       and (p_to   is null or s.disbursed_date <= p_to))::bigint,
    coalesce(sum(s.disbursed_amt) filter (where s.disbursed_date is not null
                       and (p_from is null or s.disbursed_date >= p_from)
                       and (p_to   is null or s.disbursed_date <= p_to)), 0),
    count(*) filter (where s.is_referral
                       and (p_from is null or s.created_at::date >= p_from)
                       and (p_to   is null or s.created_at::date <= p_to))::bigint,
    count(*) filter (where s.is_referral and s.pf_date is not null
                       and (p_from is null or s.pf_date >= p_from)
                       and (p_to   is null or s.pf_date <= p_to))::bigint
  from scoped s
  group by 1, 2
  order by 3 desc, 2;
$function$;
