-- =========================================================
-- ROW LEVEL SECURITY — CONSULTANT PORTAL (lead_messages)
-- Reuses can_view_lead() from Lead Management's RLS file.
-- =========================================================

alter table lead_messages enable row level security;
alter table lead_messages force row level security;

-- Visible to anyone who can already see the lead (Consultant/BD who
-- sourced it, or RM/Manager/Admin handling it) — cascades from the
-- same visibility rule as lead_events, no new logic needed.
create policy lead_messages_select on lead_messages
  for select using (can_view_lead(lead_id));

create policy lead_messages_insert on lead_messages
  for insert with check (can_view_lead(lead_id) and sender_id = auth.uid());

-- No update/delete policy — messages are immutable once sent, same
-- "never overwrite" principle as every other event/timeline table.
