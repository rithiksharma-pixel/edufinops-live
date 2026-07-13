-- =========================================================
-- ROW LEVEL SECURITY — DOCUMENT MANAGEMENT
-- Internal-team-only, matching the brief: Consultants/BD have no
-- Documents nav item and never see document rows, same lockout
-- pattern as deals.
-- =========================================================

alter table document_types enable row level security;
alter table document_types force row level security;
alter table documents enable row level security;
alter table documents force row level security;
alter table document_events enable row level security;
alter table document_events force row level security;

create policy document_types_select on document_types
  for select using (is_admin() or is_manager() or is_rm() or is_counselor());
create policy document_types_admin_write on document_types
  for insert with check (is_admin());
create policy document_types_admin_update on document_types
  for update using (is_admin()) with check (is_admin());

create policy documents_select on documents
  for select using (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
  );

create policy documents_insert on documents
  for insert with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
  );

-- Only the verification fields should really change after upload;
-- enforced by convention in the service layer (update sets only
-- verification_status/verified_by/verified_at/rejection_reason),
-- RLS grants the same roles as insert since re-uploads (replace) also
-- go through update in the current design.
create policy documents_update on documents
  for update using (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
  ) with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
  );

create policy document_events_select on document_events
  for select using (
    is_admin()
    or exists (select 1 from documents d where d.id = document_events.document_id and can_view_lead(d.lead_id))
  );
create policy document_events_insert on document_events
  for insert with check (
    is_admin()
    or exists (select 1 from documents d where d.id = document_events.document_id and can_view_lead(d.lead_id))
  );
