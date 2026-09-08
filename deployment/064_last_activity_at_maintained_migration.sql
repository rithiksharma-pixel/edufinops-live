-- =========================================================
-- 064 - Maintain last_activity_at, so contact recency is queryable
--
-- The column existed on leads and was populated on 7 rows out of 13,260.
-- Nothing ever maintained it, so "when did anyone last touch this lead" could
-- only be answered by scanning lead_events per row. That is why the weekly
-- review derives recency in a lateral subquery, and why the leads list could
-- not offer it as a filter at all.
--
-- Recency is the largest operational signal in this database: 6,643 OPEN
-- leads have had no contact in over a month. Making it a maintained, indexed
-- column turns that from an analysis into a filter, which is what the
-- "Untouched 30+ days" standard view needs.
--
-- Backfill takes the newest real event per lead, falling back to created_at
-- so a lead nobody has ever touched still sorts by its own age instead of
-- being null and invisible.
-- =========================================================

update leads l
   set last_activity_at = greatest(
         coalesce((select max(e.created_at) from lead_events e
                    where e.lead_id = l.id and not e.is_deleted), l.created_at),
         l.created_at)
 where not l.is_deleted
   and l.last_activity_at is distinct from greatest(
         coalesce((select max(e.created_at) from lead_events e
                    where e.lead_id = l.id and not e.is_deleted), l.created_at),
         l.created_at);

-- Every real touch lands in lead_events, so one trigger there covers calls,
-- stage changes, reassignment and activity-form submissions.
create or replace function public.touch_lead_activity()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.is_deleted then return new; end if;
  update leads
     set last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
   where id = new.lead_id;
  return new;
end;
$function$;

drop trigger if exists trg_touch_lead_activity on public.lead_events;
create trigger trg_touch_lead_activity
  after insert on public.lead_events
  for each row execute function public.touch_lead_activity();

create index if not exists idx_leads_last_activity
  on public.leads(last_activity_at)
  where is_deleted = false;
