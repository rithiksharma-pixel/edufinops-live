-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- Documents were only grouped by who they belong to (Student vs
-- Co-applicant). Adds a content category (KYC / Academics / Financials /
-- Other) so the Documents tab can show e.g. "Student KYC" separately
-- from "Student Academics" instead of one flat list per person.
-- Existing document types default to 'Other' — an Admin needs to
-- re-classify them from Settings after this runs.

alter table document_types add column if not exists category text not null default 'Other'
  check (category in ('KYC', 'Academics', 'Financials', 'Other'));
