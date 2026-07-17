-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- No real lenders are onboarded yet (no Lender-role users/loan officers
-- exist), so the RM team needs a way to start and manage a deal manually
-- from rm-workspace instead of waiting on share_lead_with_lender's
-- current hard requirement for an existing loan officer at the lender.
--
-- 1. Adds deals.lender_branch_id — the only real "region" concept in the
--    schema is lender_branches (a lender's regional offices); nothing on
--    deals references it yet.
-- 2. Makes share_lead_with_lender's p_loan_officer_id optional, skipping
--    the lender-org-ownership check when it's null, so a deal can be
--    started without a loan officer to assign it to yet.

alter table deals add column if not exists lender_branch_id uuid references lender_branches(id);

create or replace function share_lead_with_lender(
  p_lead_lender_status_id uuid,
  p_loan_officer_id uuid default null,
  p_remarks text default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_row lead_lender_status%rowtype;
  v_officer_org uuid;
  v_deal_id uuid;
  v_opening_stage_id uuid;
begin
  select * into v_row from lead_lender_status where id = p_lead_lender_status_id for update;
  if not found then
    raise exception 'Lender row % not found or not visible', p_lead_lender_status_id;
  end if;
  if v_row.share_status = 'Shared' then
    raise exception 'This lender is already marked Shared for this lead';
  end if;

  if p_loan_officer_id is not null then
    select lender_organization_id into v_officer_org from users where id = p_loan_officer_id;
    if v_officer_org is null or v_officer_org != v_row.lender_id then
      raise exception 'Selected officer does not belong to this lender';
    end if;
  end if;

  select id into v_opening_stage_id from deal_stages where sequence_order = (select min(sequence_order) from deal_stages where is_deleted = false) and is_deleted = false;

  v_deal_id := gen_random_uuid();
  insert into deals (id, lead_id, lender_id, current_deal_stage_id, assigned_loan_officer_id, remarks, created_by, updated_by)
  values (v_deal_id, v_row.lead_id, v_row.lender_id, v_opening_stage_id, p_loan_officer_id, p_remarks, auth.uid(), auth.uid());

  insert into deal_bank_prospect_details (deal_id) values (v_deal_id) on conflict (deal_id) do nothing;

  update lead_lender_status
  set share_status = 'Shared', deal_id = v_deal_id, not_shared_reason_id = null, not_shared_other_text = null, updated_by = auth.uid()
  where id = p_lead_lender_status_id;

  return v_deal_id;
end;
$$;
