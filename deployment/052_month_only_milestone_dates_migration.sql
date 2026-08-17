-- =========================================================
-- 052 — Mark milestone dates that are only accurate to the month
--
-- The Bangalore/Hyderabad master sheet records Login, Sanction and PF as a
-- MONTH NUMBER, not a date. Importing those fills a real gap: roughly 2,100
-- leads currently sit at Login stage or beyond with no login date at all.
--
-- But a month written into a date column silently claims day-precision it
-- does not have. Two things go wrong if that is not tracked:
--
--   1. Turnaround. Lead->Login only became measurable last week. If ~2,100
--      leads get a login date of "the 1st", every TAT average and percentile
--      that includes them is wrong by up to 30 days in either direction.
--
--   2. Month boundaries. A lead created on 15 June with login month June
--      would get 1 June -- BEFORE it existed. That is exactly the negative
--      turnaround that took a full import and a follow-up fix to clear.
--      The import clamps for it, but the clamp itself is a guess, and a
--      guess should be labelled.
--
-- So each milestone gets a companion flag. Reports can then include these
-- leads in COUNTS (where they are correct and valuable) while excluding them
-- from any DAY-level maths. Nothing is hidden and nothing is invented.
--
-- Default false, so every date already in the system stays trusted.
-- =========================================================

alter table leads
  add column if not exists login_date_month_only    boolean not null default false,
  add column if not exists sanction_date_month_only boolean not null default false,
  add column if not exists pf_date_month_only       boolean not null default false;

comment on column leads.login_date_month_only is
  'True when login_date came from a month number, not a real date. The day part is not meaningful: count these leads, but exclude them from turnaround maths.';
comment on column leads.sanction_date_month_only is
  'True when sanction_date came from a month number, not a real date. See login_date_month_only.';
comment on column leads.pf_date_month_only is
  'True when pf_date came from a month number, not a real date. See login_date_month_only.';

-- Partial indexes: every report that wants day-level accuracy filters these
-- out, and the flagged rows are the minority.
create index if not exists idx_leads_login_month_only
  on leads (login_date) where login_date_month_only;
