-- Run this once on an EXISTING project that predates this file.
--
-- Adds an explicit p_allow_skip to change_deal_stage so the deal-history
-- importer can set a deal's final historical stage in one call (e.g.
-- straight to PF) without depending on is_admin() being true for whoever
-- runs the import. The 4-arg signature is dropped first so only one
-- change_deal_stage remains — its trailing DEFAULT args would otherwise
-- register a second overload and make PostgREST ambiguous. The live UI
-- still calls it with 4 named args; p_allow_skip defaults to false there.

drop function if exists public.change_deal_stage(uuid, uuid, uuid, text);

create or replace function public.change_deal_stage(
  p_deal_id uuid,
  p_new_stage_id uuid,
  p_new_status_id uuid default null,
  p_remarks text default null,
  p_allow_skip boolean default false
)
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
  select id, name, sequence_order into v_new_stage from deal_stages where id = p_new_stage_id;

  if v_new_stage.sequence_order > v_old_stage.sequence_order + 10
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
  elsif v_new_stage.name = 'PF' then
    insert into deal_pf_details (deal_id) values (p_deal_id) on conflict (deal_id) do nothing;
  end if;

  insert into deal_events (deal_id, event_type, from_stage_id, to_stage_id, remarks, created_by)
  values (p_deal_id, 'Stage Changed', v_old_stage_id, p_new_stage_id, p_remarks, auth.uid());
end;
$function$;
