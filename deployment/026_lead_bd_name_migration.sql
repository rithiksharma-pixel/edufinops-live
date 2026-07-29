-- Run this once on an EXISTING project that predates this file.
-- ALREADY APPLIED to the live project (migration 026_lead_bd_name).
-- Guarded with IF NOT EXISTS, so re-running is safe.
--
-- Per-lead BD name, captured alongside the consultancy when a lead's
-- source is BD Partnership.
--
-- consultancies.bd_manager already records who owns a consultancy
-- RELATIONSHIP, but that is not the same thing: the BD person who
-- actually brought in a given student can differ from the account owner,
-- and it changes over time. Storing it on the lead keeps the attribution
-- correct at the moment of capture rather than re-deriving it later from
-- whatever the consultancy record happens to say by then.
--
-- Nullable and unconstrained: only meaningful for BD Partnership leads.
-- The New Lead form requires it for that source and prefills it from
-- consultancies.bd_manager, so the common case is still no typing.
-- Existing leads keep NULL — this is not backfilled, because guessing
-- the BD person retrospectively would invent attribution data.

alter table leads add column if not exists bd_name text;

comment on column leads.bd_name is
  'BD person who sourced this lead. Prefilled from consultancies.bd_manager but editable per lead.';
