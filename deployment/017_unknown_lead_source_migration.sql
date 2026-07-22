-- =========================================================
-- Adds a fallback "Unknown" lead source, used by the leads CSV
-- importer when a historical migration row leaves source_name blank
-- (lead_source_id is NOT NULL on leads, so some value is required).
--
-- NOTE: lead_sources.category has a CHECK constraint allowing only
-- Consultant / Business Development / Direct / Referral / Campaign, so
-- 'Direct' is used here — an earlier version used 'Migrated', which
-- failed that constraint and left the source missing (blank-source
-- import rows then errored). lead_sources.name is NOT unique, so this
-- guards with WHERE NOT EXISTS rather than ON CONFLICT.
-- =========================================================
insert into lead_sources (name, category)
select 'Unknown', 'Direct'
where not exists (select 1 from lead_sources where name = 'Unknown' and is_deleted = false);
