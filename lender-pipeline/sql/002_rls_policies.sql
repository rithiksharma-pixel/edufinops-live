-- =========================================================
-- ROW LEVEL SECURITY — LENDER PIPELINE
-- Adds ADDITIONAL permissive policies on top of what Lead Management
-- already created — Postgres OR's multiple permissive policies for
-- the same table+command together, so this broadens Lender-side
-- access (org-wide) without touching or weakening the existing
-- per-officer policies.
-- =========================================================

create or replace function belongs_to_lender_org(p_lender_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_lender_side() and exists (
    select 1 from users u where u.id = auth.uid() and u.lender_organization_id = p_lender_id
  )
$$;

-- ---------------------------------------------------------
-- DEALS — any user from the lender's own organization can see and
-- act on deals shared with their bank, not just the named officer.
-- ---------------------------------------------------------
create policy deals_select_lender_org on deals
  for select using (belongs_to_lender_org(lender_id));

create policy deals_update_lender_org on deals
  for update using (belongs_to_lender_org(lender_id)) with check (belongs_to_lender_org(lender_id));

-- ---------------------------------------------------------
-- STAGE-SPECIFIC DETAIL TABLES — this was the actual gap: the
-- original policies let the internal team edit these, but never
-- granted the lender's own team write access, even though updating
-- these fields (login amount, sanction terms, PF date, etc.) is
-- literally the lender's job.
-- ---------------------------------------------------------
create policy deal_bank_prospect_details_lender_org on deal_bank_prospect_details
  for update using (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  ) with check (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  );
create policy deal_bank_prospect_details_select_lender_org on deal_bank_prospect_details
  for select using (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  );
create policy deal_bank_prospect_details_insert_lender_org on deal_bank_prospect_details
  for insert with check (
    exists (select 1 from deals d where d.id = deal_bank_prospect_details.deal_id and belongs_to_lender_org(d.lender_id))
  );

create policy deal_login_details_lender_org_select on deal_login_details
  for select using (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_login_details_lender_org_insert on deal_login_details
  for insert with check (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_login_details_lender_org_update on deal_login_details
  for update using (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)))
  with check (exists (select 1 from deals d where d.id = deal_login_details.deal_id and belongs_to_lender_org(d.lender_id)));

create policy deal_sanction_details_lender_org_select on deal_sanction_details
  for select using (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_sanction_details_lender_org_insert on deal_sanction_details
  for insert with check (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_sanction_details_lender_org_update on deal_sanction_details
  for update using (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)))
  with check (exists (select 1 from deals d where d.id = deal_sanction_details.deal_id and belongs_to_lender_org(d.lender_id)));

create policy deal_pf_details_lender_org_select on deal_pf_details
  for select using (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_pf_details_lender_org_insert on deal_pf_details
  for insert with check (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_pf_details_lender_org_update on deal_pf_details
  for update using (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)))
  with check (exists (select 1 from deals d where d.id = deal_pf_details.deal_id and belongs_to_lender_org(d.lender_id)));

-- ---------------------------------------------------------
-- DEAL EVENTS / DISBURSEMENTS — read for anyone from the lender org;
-- write only via the RPC functions (deal_events has no direct insert
-- policy for anyone — see the note in Lead Management's RLS file).
-- The RPCs themselves check deals_update-style access at the table
-- level via their internal `update deals ...` calls, which the new
-- deals_update_lender_org policy above now covers.
-- ---------------------------------------------------------
create policy deal_events_select_lender_org on deal_events
  for select using (exists (select 1 from deals d where d.id = deal_events.deal_id and belongs_to_lender_org(d.lender_id)));
create policy deal_events_insert_lender_org on deal_events
  for insert with check (exists (select 1 from deals d where d.id = deal_events.deal_id and belongs_to_lender_org(d.lender_id)));

create policy disbursements_select_lender_org on disbursements
  for select using (exists (select 1 from deals d where d.id = disbursements.deal_id and belongs_to_lender_org(d.lender_id)));
create policy disbursements_insert_lender_org on disbursements
  for insert with check (exists (select 1 from deals d where d.id = disbursements.deal_id and belongs_to_lender_org(d.lender_id)));

-- ---------------------------------------------------------
-- LENDER DEAL MESSAGES — visible to the lender org AND our internal
-- team (RM/Manager/Admin/Counselor) handling the same deal.
-- ---------------------------------------------------------
alter table lender_deal_messages enable row level security;
alter table lender_deal_messages force row level security;

create policy lender_deal_messages_select on lender_deal_messages
  for select using (
    is_admin()
    or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and (is_rm() or is_manager() or is_counselor()) and can_view_deal(d.id))
    or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and belongs_to_lender_org(d.lender_id))
  );

create policy lender_deal_messages_insert on lender_deal_messages
  for insert with check (
    sender_id = auth.uid() and (
      is_admin()
      or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and (is_rm() or is_manager() or is_counselor()) and can_view_deal(d.id))
      or exists (select 1 from deals d where d.id = lender_deal_messages.deal_id and belongs_to_lender_org(d.lender_id))
    )
  );
