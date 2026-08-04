-- =========================================================
-- 040 — Funnel counts in one query instead of a full-table page-through
--
-- WHY THIS EXISTS
-- ---------------
-- getStageCounts() used to fetchAll() the leads table just to count it:
-- 11,949 rows at 1000 per request is TWELVE sequential round trips to
-- produce EIGHT numbers. listLeads() did the same thing again for the list
-- itself. Twenty-four serial requests and several MB of JSON on every page
-- load and every filter change, at ~200ms per round trip.
--
-- The database was never the bottleneck — the same work server-side runs in
-- ~10-20ms. The cost was entirely in shipping the table to the browser.
--
-- SECURITY INVOKER (the default) so RLS still decides what the caller may
-- count. No role logic here; the database is the scoping boundary.
--
-- The stage filter is deliberately NOT a parameter. The funnel cards are the
-- stage selector, so scoping them by the selected stage would zero every
-- other card. Every other filter is mirrored from applyLeadFilters, search
-- included, so the cards and the list can never disagree.
--
-- Verified under RLS against a direct group-by: all eight stages match, and
-- filtered totals match too (RM=Damini 546 = 546, search "999" 163 = 163).
-- =========================================================

create or replace function public.lead_stage_counts(
  p_source_id    uuid    default null,
  p_rm_id        uuid    default null,
  p_priority     text    default null,
  p_overdue_only boolean default false,
  p_search       text    default null,
  p_date_field   text    default 'created_at',
  p_date_from    date    default null,
  p_date_to      date    default null
)
returns table (stage_id uuid, leads bigint)
language sql
stable
set search_path to 'public'
as $function$
  select l.current_stage_id, count(*)::bigint
  from leads l
  where not l.is_deleted
    and (p_source_id is null or l.lead_source_id = p_source_id)
    and (p_rm_id     is null or l.assigned_rm_id = p_rm_id)
    and (p_priority  is null or p_priority = '' or l.priority = p_priority)
    and (not coalesce(p_overdue_only, false) or l.next_follow_up_at < now())
    and (
      p_search is null or p_search = ''
      or l.student_name  ilike '%' || p_search || '%'
      or l.student_phone ilike '%' || p_search || '%'
    )
    -- Only the two intended timestamps are reachable, same whitelist the
    -- client-side filter uses. p_date_to is inclusive of the whole day.
    and (p_date_from is null or
         (case when p_date_field = 'updated_at' then l.updated_at else l.created_at end)
           >= p_date_from::timestamptz)
    and (p_date_to is null or
         (case when p_date_field = 'updated_at' then l.updated_at else l.created_at end)
           < (p_date_to + 1)::timestamptz)
  group by l.current_stage_id;
$function$;

comment on function public.lead_stage_counts(uuid, uuid, text, boolean, text, text, date, date) is
  'Per-stage lead counts for the Lead Management funnel row. Replaces a client-side full-table page-through. RLS-scoped to the caller.';
