-- =========================================================
-- SEED DATA — safe to run once on a fresh database
-- =========================================================

insert into roles (name, description) values
  ('Admin', 'Full platform access'),
  ('Manager', 'Oversees a team of RMs, sees team-wide dashboards'),
  ('Relationship Manager', 'Owns assigned leads end-to-end'),
  ('Business Development', 'Generates leads through partnerships/campaigns'),
  ('Consultant', 'External partner submitting student leads'),
  ('Counselor', 'Internal sales team member, assignable per deal'),
  ('Lender', 'Future: lending partner login (loan officers, bank RMs)')
on conflict (name) do nothing;

insert into lead_stages (name, sequence_order, is_terminal, color) values
  ('Lead Created',          10, false, '#888780'),
  ('Contacted',             20, false, '#378ADD'),
  ('Connected',             30, false, '#378ADD'),
  ('Interested',            40, false, '#1D9E75'),
  ('Documents Requested',   50, false, '#BA7517'),
  ('Documents Received',    60, false, '#BA7517'),
  ('Shared With Lender',    70, false, '#7F77DD'),
  ('Sanctioned',            80, false, '#639922'),
  ('PF Paid',               90, false, '#639922'),
  ('Disbursed',            100, true,  '#0F6E56'),
  ('Dropped',              110, true,  '#E24B4A'),
  ('Lost',                 120, true,  '#E24B4A')
on conflict (name) do nothing;

insert into lead_sources (name, category) values
  ('Direct Website Inquiry', 'Direct'),
  ('WhatsApp Inbound',       'Direct'),
  ('Consultant Referral',    'Consultant'),
  ('BD Partnership',         'Business Development'),
  ('University Tie-up',      'Business Development'),
  ('Digital Campaign',       'Campaign'),
  ('Existing Customer Referral', 'Referral'),
  ('Unknown',                'Migrated')
on conflict do nothing;

-- =========================================================
-- DEAL STAGES — per the Deal Stage Flow diagram
-- =========================================================
insert into deal_stages (name, sequence_order, is_terminal) values
  ('Bank Prospect', 10, false),
  ('Login',         20, false),
  ('Sanction',      30, false),
  ('PF',            40, false),
  ('Disbursement',  50, false),
  ('Closed Won',    60, true)
on conflict (name) do nothing;

-- =========================================================
-- DEAL STAGE STATUSES — "positive path" sub-status per stage.
-- On Hold / Rejected are deliberately excluded here; they're
-- overlay flags on the deal itself (deals.is_on_hold / is_rejected).
-- =========================================================
insert into deal_stage_statuses (deal_stage_id, name, sequence_order, is_terminal_for_stage)
select id, 'Open', 10, false from deal_stages where name = 'Bank Prospect'
union all
select id, 'Moved to Login', 20, true from deal_stages where name = 'Bank Prospect'
union all
select id, 'Login Pending', 10, false from deal_stages where name = 'Login'
union all
select id, 'Login Done', 20, true from deal_stages where name = 'Login'
union all
select id, 'Sanction Pending', 10, false from deal_stages where name = 'Sanction'
union all
select id, 'Sanction Approved', 20, true from deal_stages where name = 'Sanction'
union all
select id, 'PF Pending', 10, false from deal_stages where name = 'PF'
union all
select id, 'PF Paid', 20, true from deal_stages where name = 'PF'
union all
select id, 'Requested', 10, false from deal_stages where name = 'Disbursement'
union all
select id, 'Partially Disbursed', 20, false from deal_stages where name = 'Disbursement'
union all
select id, 'Fully Disbursed', 30, true from deal_stages where name = 'Disbursement'
union all
select id, 'Closed Won', 10, true from deal_stages where name = 'Closed Won'
on conflict (deal_stage_id, name) do nothing;

-- =========================================================
-- DEAL REJECTION REASONS
-- =========================================================
insert into deal_rejection_reasons (name) values
  ('Credit Score'),
  ('Low Income'),
  ('Documentation'),
  ('Property'),
  ('Co-applicant / Eligibility'),
  ('Bank Policy'),
  ('Other')
on conflict (name) do nothing;

-- =========================================================
-- DEAL HOLD REASONS
-- =========================================================
insert into deal_hold_reasons (name) values
  ('Waiting for Student'),
  ('Waiting for Consultant'),
  ('Waiting for Bank'),
  ('Waiting for Documents'),
  ('Other')
on conflict (name) do nothing;
