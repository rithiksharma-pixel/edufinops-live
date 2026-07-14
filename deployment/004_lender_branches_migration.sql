-- Run this once on an EXISTING project that was created with an earlier
-- version of the master migration. Fresh projects already get this from
-- 000_master_migration.sql.
--
-- Adds lender_branches (region/office within a lender institution) and
-- fixes a real access-control bug: every deal-related table had an
-- org-wide "_lender_org" policy that let ANY active user at a lender
-- institution see/edit deals shared with it, instead of only the
-- specifically assigned officer. can_view_deal() already scoped this
-- correctly in parallel; this drops the org-wide grant everywhere,
-- adding the correct per-person branch first wherever the org-wide
-- policy was the only source of lender write access.

create table if not exists lender_branches (
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
create index if not exists idx_lender_branches_lender_id on lender_branches(lender_id);
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

alter policy deal_bank_prospect_details_update on deal_bank_prospect_details using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);
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

alter policy lender_deal_messages_select on lender_deal_messages using (can_view_deal(deal_id));
alter policy lender_deal_messages_insert on lender_deal_messages with check (sender_id = auth.uid() and can_view_deal(deal_id));

drop function if exists invite_user(text, text, uuid, uuid);
create or replace function invite_user(
  p_email text,
  p_full_name text,
  p_role_id uuid,
  p_reporting_manager_id uuid default null,
  p_lender_organization_id uuid default null,
  p_lender_branch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation_id uuid;
begin
  if not is_admin() then
    raise exception 'Only an Admin can invite users';
  end if;

  insert into invitations (email, full_name, role_id, reporting_manager_id, lender_organization_id, lender_branch_id, invited_by)
  values (p_email, p_full_name, p_role_id, p_reporting_manager_id, p_lender_organization_id, p_lender_branch_id, auth.uid())
  returning id into v_invitation_id;

  return v_invitation_id;
end;
$$;

create or replace function accept_invitation(
  p_invitation_id uuid,
  p_new_auth_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
begin
  select * into v_invite from invitations where id = p_invitation_id and status = 'pending' for update;
  if not found then
    raise exception 'Invitation % not found or already used', p_invitation_id;
  end if;
  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'Invitation % has expired', p_invitation_id;
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, lender_organization_id, lender_branch_id, created_by)
  values (p_new_auth_user_id, v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_invite.invited_by);

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = p_new_auth_user_id
  where id = p_invitation_id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (p_new_auth_user_id, 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;

create or replace function accept_my_invitation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invitations%rowtype;
  v_email text;
begin
  v_email := auth.jwt() ->> 'email';
  if v_email is null then
    raise exception 'No authenticated email found on this session';
  end if;

  select * into v_invite from invitations
  where email = v_email and status = 'pending'
  order by invited_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No pending invitation found for %', v_email;
  end if;

  if v_invite.expires_at < now() then
    update invitations set status = 'expired' where id = v_invite.id;
    raise exception 'This invitation has expired — ask your admin to send a new one';
  end if;

  insert into users (id, role_id, full_name, email, reporting_manager_id, lender_organization_id, lender_branch_id, created_by)
  values (auth.uid(), v_invite.role_id, v_invite.full_name, v_invite.email, v_invite.reporting_manager_id, v_invite.lender_organization_id, v_invite.lender_branch_id, v_invite.invited_by)
  on conflict (id) do nothing;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = auth.uid()
  where id = v_invite.id;

  insert into user_role_events (user_id, event_type, new_role_id, new_manager_id, created_by)
  values (auth.uid(), 'Activated', v_invite.role_id, v_invite.reporting_manager_id, v_invite.invited_by);
end;
$$;
