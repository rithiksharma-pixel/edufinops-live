-- =========================================================
-- LENDER BRANCHES + strict per-person deal access
--
-- Part 1: adds lender_branches (region/office within a lender org) and
-- links users/invitations to a specific branch, so a Lender-role person
-- can be onboarded as "Prajwal at HDFC Credila Bangalore", not just
-- "someone at HDFC Credila".
--
-- Part 2: the actual access-control fix. can_view_deal() already scopes
-- lender-side access correctly to the ASSIGNED officer
-- (assigned_loan_officer_id = auth.uid(), or bank_rm_id on the bank
-- prospect row) — but a later, overly-broad set of "_lender_org"
-- policies (built on belongs_to_lender_org(), which checks only the
-- lender ORGANIZATION, not the person) grants every active user at that
-- institution visibility into every deal shared with it. This section
-- removes that org-wide grant everywhere it exists, adding a correctly
-- per-person-scoped branch first on the handful of tables where the
-- org-wide policy was the ONLY thing giving lenders write access at all
-- (login/sanction/PF detail edits, disbursements) so that legitimate
-- access isn't lost in the process.
-- =========================================================

create table lender_branches (
  id          uuid primary key default gen_random_uuid(),
  lender_id   uuid not null references lenders(id),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  is_deleted  boolean not null default false,
  status      text not null default 'active',
  unique (lender_id, name)
);
create index idx_lender_branches_lender_id on lender_branches(lender_id);
create trigger trg_lender_branches_updated_at
  before update on lender_branches
  for each row execute function set_updated_at();

alter table users add column if not exists lender_branch_id uuid references lender_branches(id);
alter table invitations add column if not exists lender_organization_id uuid references lenders(id);
alter table invitations add column if not exists lender_branch_id uuid references lender_branches(id);

alter table lender_branches enable row level security;
alter table lender_branches force row level security;
create policy lender_branches_select on lender_branches for select using (auth.uid() is not null);
create policy lender_branches_write on lender_branches for insert with check (is_admin());
create policy lender_branches_update on lender_branches for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------
-- Drop outright: fully redundant with the existing can_view_deal()
-- based policy on the same table/command, which already scopes
-- lender-side access to the assigned person.
-- ---------------------------------------------------------
drop policy if exists deals_select_lender_org on deals;
drop policy if exists deals_update_lender_org on deals;
drop policy if exists deal_bank_prospect_details_select_lender_org on deal_bank_prospect_details;
drop policy if exists deal_bank_prospect_details_insert_lender_org on deal_bank_prospect_details;
drop policy if exists deal_bank_prospect_details_lender_org on deal_bank_prospect_details;
drop policy if exists deal_events_select_lender_org on deal_events;
drop policy if exists deal_events_insert_lender_org on deal_events;
drop policy if exists deal_login_details_lender_org_select on deal_login_details;
drop policy if exists deal_sanction_details_lender_org_select on deal_sanction_details;
drop policy if exists deal_pf_details_lender_org_select on deal_pf_details;
drop policy if exists disbursements_select_lender_org on disbursements;

-- ---------------------------------------------------------
-- Add the correct per-person branch to the base write/update policies
-- BEFORE dropping the org-wide ones — these four are currently the
-- only source of lender write access on their tables.
-- ---------------------------------------------------------
alter policy deal_login_details_write on deal_login_details with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_login_details_update on deal_login_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy deal_sanction_details_write on deal_sanction_details with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_sanction_details_update on deal_sanction_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy deal_pf_details_write on deal_pf_details with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
alter policy deal_pf_details_update on deal_pf_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

alter policy disbursements_write on disbursements with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

drop policy if exists deal_login_details_lender_org_insert on deal_login_details;
drop policy if exists deal_login_details_lender_org_update on deal_login_details;
drop policy if exists deal_sanction_details_lender_org_insert on deal_sanction_details;
drop policy if exists deal_sanction_details_lender_org_update on deal_sanction_details;
drop policy if exists deal_pf_details_lender_org_insert on deal_pf_details;
drop policy if exists deal_pf_details_lender_org_update on deal_pf_details;
drop policy if exists disbursements_insert_lender_org on disbursements;

-- ---------------------------------------------------------
-- lender_deal_messages: rewrite in place. can_view_deal() already
-- covers admin/manager/rm/counselor/lender-officer/bank_rm in one
-- call, so this both fixes the org-wide leak and simplifies the policy.
-- ---------------------------------------------------------
alter policy lender_deal_messages_select on lender_deal_messages using (
  can_view_deal(deal_id)
);
alter policy lender_deal_messages_insert on lender_deal_messages with check (
  sender_id = auth.uid() and can_view_deal(deal_id)
);
