-- =========================================================
-- 061 — Deleting a lead, and editing many at once
--
-- Deleting a lead had no route at all: no DELETE policy, no RPC, no UI. An
-- Admin looking at a bad import or a duplicate could only leave it there.
--
-- These are SOFT deletes. leads is referenced by deals, documents, events,
-- activities and more, so a hard delete would either cascade away real
-- history or fail on a foreign key. is_deleted = true is already what every
-- read path filters on, and restore_lead puts one back.
--
-- Deliberately RPCs rather than policies: the delete has to write a
-- lead_events row so the timeline shows who removed it and why, and "who may
-- delete" must not be a client-side decision.
--
-- update_leads_bulk takes a WHITELIST. A generic "apply this jsonb" would let
-- the client write ownership, audit or automation columns that have their own
-- flows and their own event logging. Anything outside the list is refused by
-- name, so a stale client cannot widen what a bulk edit can touch.
-- =========================================================

create or replace function public.delete_lead(p_lead_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_stage uuid;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an Admin can delete a lead.' using errcode = '42501';
  end if;

  select current_stage_id into v_stage from leads where id = p_lead_id and not is_deleted;
  if not found then
    raise exception 'Lead not found, or already deleted.' using errcode = 'P0002';
  end if;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_lead_id, 'Lead Updated (bulk import)', v_stage, v_stage,
          'Deleted by an Admin' || coalesce(' - ' || nullif(btrim(p_reason), ''), ''), auth.uid());

  update leads
     set is_deleted = true, status = 'deleted', updated_at = now(), updated_by = auth.uid()
   where id = p_lead_id;
end;
$function$;

create or replace function public.restore_lead(p_lead_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an Admin can restore a lead.' using errcode = '42501';
  end if;
  update leads
     set is_deleted = false, status = 'active', updated_at = now(), updated_by = auth.uid()
   where id = p_lead_id and is_deleted;
  if not found then
    raise exception 'Lead not found, or not deleted.' using errcode = 'P0002';
  end if;
end;
$function$;

-- Returns how many actually went, which can be fewer than asked, so the UI
-- reports the truth rather than assuming every id was eligible.
create or replace function public.delete_leads_bulk(p_lead_ids uuid[], p_reason text default null)
returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare v_count integer;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an Admin can delete leads.' using errcode = '42501';
  end if;
  if p_lead_ids is null or array_length(p_lead_ids, 1) is null then return 0; end if;
  if array_length(p_lead_ids, 1) > 500 then
    raise exception 'Delete at most 500 leads at a time.' using errcode = '22023';
  end if;

  insert into lead_events (lead_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  select l.id, 'Lead Updated (bulk import)', l.current_stage_id, l.current_stage_id,
         'Deleted by an Admin (bulk)' || coalesce(' - ' || nullif(btrim(p_reason), ''), ''), auth.uid()
  from leads l where l.id = any(p_lead_ids) and not l.is_deleted;

  update leads
     set is_deleted = true, status = 'deleted', updated_at = now(), updated_by = auth.uid()
   where id = any(p_lead_ids) and not is_deleted;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create or replace function public.update_leads_bulk(p_lead_ids uuid[], p_patch jsonb)
returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_count integer;
  v_allowed text[] := array['priority','lead_source_id','consultancy_id','consultancy_other_name',
                            'bd_name','destination_country','intake_month','intake_year',
                            'loan_type','currency'];
  k text;
begin
  if not coalesce(public.is_admin_or_manager(), false) then
    raise exception 'Only an Admin or Manager can bulk edit leads.' using errcode = '42501';
  end if;
  if p_lead_ids is null or array_length(p_lead_ids, 1) is null then return 0; end if;
  if array_length(p_lead_ids, 1) > 500 then
    raise exception 'Edit at most 500 leads at a time.' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any(v_allowed)) then
      raise exception '% cannot be set in a bulk edit.', k using errcode = '42501';
    end if;
  end loop;

  update leads l set
    priority               = coalesce(p_patch->>'priority', l.priority),
    lead_source_id         = coalesce((p_patch->>'lead_source_id')::uuid, l.lead_source_id),
    consultancy_id         = case when p_patch ? 'consultancy_id'
                                  then (p_patch->>'consultancy_id')::uuid else l.consultancy_id end,
    consultancy_other_name = case when p_patch ? 'consultancy_other_name'
                                  then p_patch->>'consultancy_other_name' else l.consultancy_other_name end,
    bd_name                = coalesce(p_patch->>'bd_name', l.bd_name),
    destination_country    = coalesce(p_patch->>'destination_country', l.destination_country),
    intake_month           = coalesce((p_patch->>'intake_month')::int, l.intake_month),
    intake_year            = coalesce((p_patch->>'intake_year')::int, l.intake_year),
    loan_type              = coalesce(p_patch->>'loan_type', l.loan_type),
    currency               = coalesce(p_patch->>'currency', l.currency),
    updated_at             = now(),
    updated_by             = auth.uid()
  where l.id = any(p_lead_ids) and not l.is_deleted;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.delete_lead(uuid, text) from public, anon;
revoke all on function public.restore_lead(uuid) from public, anon;
revoke all on function public.delete_leads_bulk(uuid[], text) from public, anon;
revoke all on function public.update_leads_bulk(uuid[], jsonb) from public, anon;
grant execute on function public.delete_lead(uuid, text) to authenticated;
grant execute on function public.restore_lead(uuid) to authenticated;
grant execute on function public.delete_leads_bulk(uuid[], text) to authenticated;
grant execute on function public.update_leads_bulk(uuid[], jsonb) to authenticated;
