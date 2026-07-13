-- =========================================================
-- ROW LEVEL SECURITY — LEAD MANAGEMENT (REV 2)
-- =========================================================

create or replace function auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.name
  from users u
  join roles r on r.id = u.role_id
  where u.id = auth.uid()
    and u.is_deleted = false
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Admin' $$;

create or replace function is_manager()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Manager' $$;

create or replace function is_rm()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Relationship Manager' $$;

create or replace function is_source_role()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() in ('Consultant','Business Development') $$;

create or replace function is_counselor()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Counselor' $$;

create or replace function is_lender_side()
returns boolean language sql stable security definer set search_path = public
as $$ select auth_role() = 'Lender' $$;

create or replace function rm_reports_to_current_manager(rm_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from users u
    where u.id = rm_user_id
      and u.reporting_manager_id = auth.uid()
  )
$$;

-- Whether the current user can see the given LEAD via any path
-- (used to cascade visibility into deal-related tables)
create or replace function can_view_lead(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from leads l
    where l.id = p_lead_id
      and (
        is_admin()
        or (is_manager() and (l.assigned_manager_id = auth.uid() or rm_reports_to_current_manager(l.assigned_rm_id)))
        or (is_rm() and l.assigned_rm_id = auth.uid())
        or (is_source_role() and l.source_user_id = auth.uid())
      )
  )
$$;

-- Whether the current user can see the given DEAL via any path
create or replace function can_view_deal(p_deal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from deals d
    where d.id = p_deal_id
      and (
        is_admin()
        or (is_manager() and can_view_lead(d.lead_id))
        or (is_rm() and can_view_lead(d.lead_id))
        or (is_counselor() and d.assigned_counselor_id = auth.uid())
        or (is_lender_side() and d.assigned_loan_officer_id = auth.uid())
        or (is_lender_side() and exists (
              select 1 from deal_bank_prospect_details bpd
              where bpd.deal_id = d.id and bpd.bank_rm_id = auth.uid()
            ))
      )
  )
$$;

-- ---------------------------------------------------------
-- Enable + force RLS on every table
-- ---------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'roles','users','lead_sources','lead_stages','leads','co_applicants',
    'lead_assignments','lead_events','lenders','deal_stages','deal_stage_statuses',
    'deal_rejection_reasons','deal_hold_reasons','deals','deal_bank_prospect_details',
    'deal_login_details','deal_sanction_details','deal_pf_details','deal_events','disbursements'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- =========================================================
-- ROLES / LEAD_SOURCES / LEAD_STAGES / LENDERS — unchanged
-- =========================================================
create policy roles_select_all on roles for select using (auth.uid() is not null);
create policy roles_admin_write on roles for all using (is_admin()) with check (is_admin());

create policy lead_sources_select_all on lead_sources for select using (auth.uid() is not null);
create policy lead_sources_admin_write on lead_sources for insert with check (is_admin());
create policy lead_sources_admin_update on lead_sources for update using (is_admin()) with check (is_admin());

create policy lead_stages_select_all on lead_stages for select using (auth.uid() is not null);
create policy lead_stages_admin_write on lead_stages for insert with check (is_admin());
create policy lead_stages_admin_update on lead_stages for update using (is_admin()) with check (is_admin());

create policy lenders_select_non_consultant on lenders
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy lenders_admin_write on lenders for insert with check (is_admin());
create policy lenders_admin_update on lenders for update using (is_admin()) with check (is_admin());

-- =========================================================
-- DEAL STAGES / STAGE STATUSES / REASON LOOKUPS
-- Reference data: readable by everyone with deal visibility (not
-- Consultants/BD, who never see deal-level data at all), admin-writable.
-- =========================================================
create policy deal_stages_select on deal_stages
  for select using (is_admin() or is_manager() or is_rm() or is_counselor() or is_lender_side());
create policy deal_stages_admin_write on deal_stages for insert with check (is_admin());
create policy deal_stages_admin_update on deal_stages for update using (is_admin()) with check (is_admin());

create policy deal_stage_statuses_select on deal_stage_statuses
  for select using (is_admin() or is_manager() or is_rm() or is_counselor() or is_lender_side());
create policy deal_stage_statuses_admin_write on deal_stage_statuses for insert with check (is_admin());
create policy deal_stage_statuses_admin_update on deal_stage_statuses for update using (is_admin()) with check (is_admin());

create policy deal_rejection_reasons_select on deal_rejection_reasons
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy deal_rejection_reasons_admin_write on deal_rejection_reasons for insert with check (is_admin());
create policy deal_rejection_reasons_admin_update on deal_rejection_reasons for update using (is_admin()) with check (is_admin());

create policy deal_hold_reasons_select on deal_hold_reasons
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy deal_hold_reasons_admin_write on deal_hold_reasons for insert with check (is_admin());
create policy deal_hold_reasons_admin_update on deal_hold_reasons for update using (is_admin()) with check (is_admin());

-- =========================================================
-- USERS — unchanged
-- =========================================================
create policy users_select_self on users for select using (id = auth.uid());
create policy users_select_admin on users for select using (is_admin());
create policy users_select_manager_team on users for select using (is_manager() and reporting_manager_id = auth.uid());
create policy users_select_referenced_on_own_leads on users
  for select using (
    exists (
      select 1 from leads l
      where (l.assigned_rm_id = users.id or l.source_user_id = users.id)
        and (l.assigned_rm_id = auth.uid() or l.source_user_id = auth.uid())
    )
  );
create policy users_admin_write on users for insert with check (is_admin());
create policy users_admin_update on users for update using (is_admin() or id = auth.uid()) with check (is_admin() or id = auth.uid());

-- =========================================================
-- LEADS — extended to include Counselor visibility via their deals
-- =========================================================
create policy leads_select_admin on leads for select using (is_admin());
create policy leads_select_manager on leads for select using (
  is_manager() and (assigned_manager_id = auth.uid() or rm_reports_to_current_manager(assigned_rm_id))
);
create policy leads_select_rm on leads for select using (is_rm() and assigned_rm_id = auth.uid());
create policy leads_select_source on leads for select using (is_source_role() and source_user_id = auth.uid());
create policy leads_select_counselor on leads for select using (
  is_counselor() and exists (select 1 from deals d where d.lead_id = leads.id and d.assigned_counselor_id = auth.uid())
);

create policy leads_insert_admin on leads for insert with check (is_admin());
create policy leads_insert_manager on leads for insert with check (is_manager());
create policy leads_insert_rm on leads for insert with check (is_rm());
create policy leads_insert_source on leads for insert with check (is_source_role() and source_user_id = auth.uid());

create policy leads_update_admin on leads for update using (is_admin()) with check (is_admin());
create policy leads_update_manager on leads for update using (
  is_manager() and (assigned_manager_id = auth.uid() or rm_reports_to_current_manager(assigned_rm_id))
) with check (
  is_manager() and (assigned_manager_id = auth.uid() or rm_reports_to_current_manager(assigned_rm_id))
);
create policy leads_update_rm on leads for update using (is_rm() and assigned_rm_id = auth.uid())
  with check (is_rm() and assigned_rm_id = auth.uid());

-- =========================================================
-- CO_APPLICANTS / LEAD_ASSIGNMENTS / LEAD_EVENTS — unchanged
-- (cascade from lead visibility, same as REV 1)
-- =========================================================
create policy co_applicants_select on co_applicants for select using (can_view_lead(lead_id));
create policy co_applicants_write on co_applicants for insert with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
);
create policy co_applicants_update on co_applicants for update using (
  is_admin() or (is_rm() and can_view_lead(lead_id))
) with check (
  is_admin() or (is_rm() and can_view_lead(lead_id))
);

create policy lead_assignments_select on lead_assignments for select using (
  is_admin()
  or (is_manager() and rm_reports_to_current_manager(assigned_to_user_id))
  or (is_rm() and assigned_to_user_id = auth.uid())
);
create policy lead_assignments_insert on lead_assignments for insert with check (is_admin() or is_manager());

create policy lead_events_select on lead_events for select using (can_view_lead(lead_id));
create policy lead_events_insert on lead_events for insert with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
);

-- =========================================================
-- DEALS — the core of this revision.
-- Consultants/BD still never see deals at all (commercially sensitive).
-- Counselors see only deals they're assigned to. Lender-side users see
-- only deals where they are the named loan officer or bank RM.
-- =========================================================
create policy deals_select on deals for select using (can_view_deal(id));

create policy deals_insert on deals for insert with check (
  is_admin()
  or (is_manager() and can_view_lead(lead_id))
  or (is_rm() and can_view_lead(lead_id))
);

create policy deals_update on deals for update using (
  is_admin()
  or (is_rm() and can_view_lead(lead_id))
  or (is_counselor() and assigned_counselor_id = auth.uid())
  or (is_lender_side() and assigned_loan_officer_id = auth.uid())
) with check (
  is_admin()
  or (is_rm() and can_view_lead(lead_id))
  or (is_counselor() and assigned_counselor_id = auth.uid())
  or (is_lender_side() and assigned_loan_officer_id = auth.uid())
);

-- =========================================================
-- STAGE-SPECIFIC DETAIL TABLES — cascade from deal visibility
-- =========================================================
create policy deal_bank_prospect_details_select on deal_bank_prospect_details for select using (can_view_deal(deal_id));
create policy deal_bank_prospect_details_write on deal_bank_prospect_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_bank_prospect_details_update on deal_bank_prospect_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and bank_rm_id = auth.uid())
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and bank_rm_id = auth.uid())
);

create policy deal_login_details_select on deal_login_details for select using (can_view_deal(deal_id));
create policy deal_login_details_write on deal_login_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_login_details_update on deal_login_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);

create policy deal_sanction_details_select on deal_sanction_details for select using (can_view_deal(deal_id));
create policy deal_sanction_details_write on deal_sanction_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_sanction_details_update on deal_sanction_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);

create policy deal_pf_details_select on deal_pf_details for select using (can_view_deal(deal_id));
create policy deal_pf_details_write on deal_pf_details for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
create policy deal_pf_details_update on deal_pf_details for update using (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
) with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);

-- =========================================================
-- DEAL_EVENTS — append-only, cascades from deal visibility.
-- No UPDATE/DELETE policy exists for anyone.
-- =========================================================
create policy deal_events_select on deal_events for select using (can_view_deal(deal_id));
create policy deal_events_insert on deal_events for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
  or (is_lender_side() and can_view_deal(deal_id))
);

-- =========================================================
-- DISBURSEMENTS — cascades from deal visibility
-- =========================================================
create policy disbursements_select on disbursements for select using (can_view_deal(deal_id));
create policy disbursements_write on disbursements for insert with check (
  is_admin() or (is_rm() and can_view_deal(deal_id)) or (is_counselor() and can_view_deal(deal_id))
);
