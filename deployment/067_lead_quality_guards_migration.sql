-- =========================================================
-- 067 - Stop the lead-quality gaps growing, from every entry path
--
-- The scorecard's gaps (39% of leads with no source, 98% of lost leads with
-- no reason, 72% of logins with no bank case) are all HISTORICAL. Of the 704
-- leads created in the last 30 days, 1 has no source, none lacks a loan
-- amount, none was lost without a reason, and none reached Login without a
-- bank case: the forms already require these things.
--
-- What let the gaps in was the bulk import, which turned a blank source into
-- "Unknown" and could set a lead straight to Lost or Login. The import is
-- tightened in exportImportService.js; this migration is the rule underneath
-- every path — forms, import, portal, or anything that talks to the API
-- directly — so the old gaps can be cleaned without new ones opening.
--
--   * A new lead needs a real, active source and a loan amount above zero.
--   * "Unknown" is retired as a choice: existing leads keep it, so it stays
--     visible as the backlog to tag, but it can no longer be picked.
--   * A lead cannot become Lost without a reason. Only a CHANGE to Lost is
--     checked, so editing one of the 5,305 historical lost-without-reason
--     leads still works — they can be tagged, not frozen.
--   * find_leads_by_phone() backs the duplicate warning in the lead forms.
--   * 59 leads at Disbursement get the disbursed amount their own bank cases
--     already record. The other 687 have no amount anywhere in the system.
-- =========================================================

update lead_sources set is_active = false where name = 'Unknown' and is_active;

create or replace function public.guard_lead_quality()
returns trigger language plpgsql set search_path = public as $function$
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
    if coalesce(new.loan_amount_requested, 0) <= 0 then
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

drop trigger if exists trg_guard_lead_quality on leads;
create trigger trg_guard_lead_quality
  before insert or update of current_stage_id, lost_reason_id on leads
  for each row execute function guard_lead_quality();

-- Duplicate warning. Internal staff only: a partner must not learn that a
-- student is already in another firm's book. Matches on the last 10 digits,
-- so "+91 98450-11237" and "9845011237" are the same number.
create or replace function public.find_leads_by_phone(p_phone text)
returns table (lead_id uuid, student_name text, stage_name text, assigned_rm text, created_at timestamptz)
language sql stable security definer set search_path = public as $function$
  select l.id, l.student_name, s.name, u.full_name, l.created_at
    from leads l
    left join lead_stages s on s.id = l.current_stage_id
    left join users u on u.id = l.assigned_rm_id
   where coalesce(is_internal_staff(), false)
     and length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 10
     and not l.is_deleted
     and right(regexp_replace(l.student_phone, '\D', '', 'g'), 10)
       = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
   order by l.created_at desc
   limit 5
$function$;

revoke all on function public.find_leads_by_phone(text) from public, anon;
grant execute on function public.find_leads_by_phone(text) to authenticated;

-- Disbursed amounts the bank cases already hold.
update leads l
   set disbursed_amount = d.amt,
       disbursed_date = coalesce(l.disbursed_date, d.dt)
  from (select lead_id, sum(total_disbursed_amount) amt, max(final_disbursement_date) dt
          from deals where not is_deleted group by lead_id) d
 where d.lead_id = l.id and d.amt > 0
   and coalesce(l.disbursed_amount, 0) = 0
   and not l.is_deleted;
