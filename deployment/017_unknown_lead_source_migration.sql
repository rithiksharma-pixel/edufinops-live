-- =========================================================
-- Adds a fallback "Unknown" lead source, used by the leads CSV
-- importer when a historical migration row leaves source_name blank
-- (lead_source_id is NOT NULL on leads, so some value is required).
-- =========================================================
insert into lead_sources (name, category) values
  ('Unknown', 'Migrated')
on conflict do nothing;
