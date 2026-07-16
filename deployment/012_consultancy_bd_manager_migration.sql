-- Run this once on an EXISTING project that predates this file.
--
-- Which internal BD person owns each consultancy relationship. Free text
-- rather than a users FK on purpose: the roster of BD staff and the
-- consultancy list are being populated in parallel (bulk import era), so
-- a name must be recordable before its owner has accepted an invite.
-- Upgrade path to a proper FK later: match these names against users
-- once routing-by-BD-manager is actually needed.

alter table consultancies add column if not exists bd_manager text;
