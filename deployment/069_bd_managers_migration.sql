-- =========================================================
-- 069 - One BD list: merge the spellings, and pick from it from now on
--
-- BD was free text in two places (leads.bd_name, consultancies.bd_manager),
-- so the BD report showed 39 "BD managers": Nitish as NITISH, nitish,
-- Nithish and Nitish Kumar; Shanthakumar six ways; placeholders like "na",
-- "Other", "-" and "Refferal"; and RM names typed into the BD field.
--
-- The business confirmed the final list of 11. This migration:
--   * creates bd_managers (Admin-managed) seeded with those 11, and
--     bd_manager_aliases so a known misspelling maps to its BD;
--   * rewrites every existing value to the canonical name, and clears the
--     values that are not a BD at all (placeholders, RM names, and names not
--     on the list), so those leads fall back to their consultancy's BD —
--     which is how the BD report already attributes a lead with no BD;
--   * keeps the value as it was in *_original columns, so nothing typed is
--     lost and any merge can be undone;
--   * adds a trigger so a BD can only ever be one on the list. A known
--     misspelling is corrected silently; anything else is refused.
-- =========================================================

create table if not exists bd_managers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id),
  is_deleted boolean not null default false
);
create unique index if not exists bd_managers_name_key on bd_managers (lower(name)) where not is_deleted;

create table if not exists bd_manager_aliases (
  alias text primary key,           -- stored normalised: lower, trimmed, no punctuation
  bd_manager_id uuid not null references bd_managers(id)
);

alter table bd_managers enable row level security;
alter table bd_manager_aliases enable row level security;
drop policy if exists bd_managers_select on bd_managers;
create policy bd_managers_select on bd_managers for select to authenticated using (true);
drop policy if exists bd_managers_admin_write on bd_managers;
create policy bd_managers_admin_write on bd_managers for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists bd_aliases_select on bd_manager_aliases;
create policy bd_aliases_select on bd_manager_aliases for select to authenticated using (true);
drop policy if exists bd_aliases_admin_write on bd_manager_aliases;
create policy bd_aliases_admin_write on bd_manager_aliases for all to authenticated using (is_admin()) with check (is_admin());

insert into bd_managers (name)
select v from unnest(array['Bhavin','Anirudh','Charith','Vamsi','Shanthakumar','Suneet','Chetan','Vinay','Nitish','Deepansh','Kunal']) v
where not exists (select 1 from bd_managers b where lower(b.name) = lower(v) and not b.is_deleted);

-- The key every spelling is compared on: case, spaces and punctuation ignored.
-- (Not bd_key(): that one keeps spaces and bd_performance() depends on it.)
create or replace function public.bd_match_key(p text)
returns text language sql immutable as $function$
  select nullif(regexp_replace(lower(coalesce(p, '')), '[^a-z]', '', 'g'), '')
$function$;

insert into bd_manager_aliases (alias, bd_manager_id)
select bd_match_key(a.alias), b.id
  from (values
    ('Nithish','Nitish'), ('Nitish Kumar','Nitish'),
    ('LKR Charith','Charith'),
    ('Santhakumar','Shanthakumar'), ('Shanta Kumar','Shanthakumar'), ('Santha Kumar','Shanthakumar'),
    ('Santakumar','Shanthakumar'), ('Shanta','Shanthakumar'),
    ('Deepanshu','Deepansh'), ('Depanshu','Deepansh'),
    ('Bhaavin','Bhavin'), ('Bhaveen','Bhavin'),
    ('Sunit','Suneet'), ('Suneeth','Suneet')
  ) a(alias, canonical)
  join bd_managers b on lower(b.name) = lower(a.canonical) and not b.is_deleted
on conflict (alias) do nothing;

/** Canonical BD name for any spelling, or null when it is not a known BD. */
create or replace function public.canonical_bd_name(p text)
returns text language sql stable security definer set search_path = public as $function$
  select coalesce(
    (select b.name from bd_managers b where bd_match_key(b.name) = bd_match_key(p) and not b.is_deleted limit 1),
    (select b.name from bd_manager_aliases a join bd_managers b on b.id = a.bd_manager_id
      where a.alias = bd_match_key(p) and not b.is_deleted limit 1))
$function$;

-- ---------- Rewrite what is there, keeping the original ----------

alter table leads add column if not exists bd_name_original text;
alter table consultancies add column if not exists bd_manager_original text;

update leads
   set bd_name_original = coalesce(bd_name_original, bd_name),
       bd_name = canonical_bd_name(bd_name)
 where bd_name is not null
   and bd_name is distinct from canonical_bd_name(bd_name);

update consultancies
   set bd_manager_original = coalesce(bd_manager_original, bd_manager),
       bd_manager = canonical_bd_name(bd_manager)
 where bd_manager is not null
   and bd_manager is distinct from canonical_bd_name(bd_manager);

-- ---------- From now on, only a BD on the list ----------

/** The canonical name for a BD field's value: null when blank, refused when
 *  it is not on the list. Shared by the two triggers below — one function per
 *  table, because PL/pgSQL cannot reference a column a row does not have,
 *  even in a branch that never runs. */
create or replace function public.resolve_bd_name(p_raw text)
returns text language plpgsql stable set search_path = public as $function$
declare v_canon text;
begin
  if bd_match_key(p_raw) is null then return null; end if;
  v_canon := canonical_bd_name(p_raw);
  if v_canon is null then
    raise exception '"%" is not on the BD list. Pick a BD from the list, or ask an Admin to add them in Settings.', btrim(p_raw)
      using errcode = 'check_violation';
  end if;
  return v_canon;
end;
$function$;

create or replace function public.enforce_lead_bd_name()
returns trigger language plpgsql set search_path = public as $function$
begin new.bd_name := resolve_bd_name(new.bd_name); return new; end;
$function$;

create or replace function public.enforce_consultancy_bd_manager()
returns trigger language plpgsql set search_path = public as $function$
begin new.bd_manager := resolve_bd_name(new.bd_manager); return new; end;
$function$;

drop trigger if exists trg_enforce_bd_name on leads;
create trigger trg_enforce_bd_name before insert or update of bd_name on leads
  for each row execute function enforce_lead_bd_name();
drop trigger if exists trg_enforce_bd_manager on consultancies;
create trigger trg_enforce_bd_manager before insert or update of bd_manager on consultancies
  for each row execute function enforce_consultancy_bd_manager();
