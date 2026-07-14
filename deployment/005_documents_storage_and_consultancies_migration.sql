-- Run this once on an EXISTING project that was created before this file
-- existed. Fresh projects already get this from 000_master_migration.sql.
--
-- FIX 1: storage.objects has RLS enabled by default with zero policies for
-- the lead-documents bucket, so every upload/download was silently denied
-- ("new row violates row-level security policy") no matter what the
-- `documents` table policy said. This mirrors documents_insert/_select,
-- extracting lead_id from the object path's first folder segment (the
-- client uploads to `${leadId}/${filename}`, see documentService.js).
--
-- FIX 2: adds a "Consultancy" lookup for the BD Partnership lead source —
-- an admin-managed list (mirrors lender_branches) plus a free-text escape
-- hatch on the lead itself ("Other") for names not yet in the list.

create policy lead_documents_insert on storage.objects
  for insert
  with check (
    bucket_id = 'lead-documents'
    and (
      public.is_admin()
      or (public.is_manager() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_rm() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_counselor() and public.can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

create policy lead_documents_select on storage.objects
  for select
  using (
    bucket_id = 'lead-documents'
    and (
      public.is_admin()
      or (public.is_manager() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_rm() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_counselor() and public.can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

create table consultancies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  is_deleted  boolean not null default false,
  status      text not null default 'active',
  unique (name)
);
create trigger trg_consultancies_updated_at
  before update on consultancies
  for each row execute function set_updated_at();

alter table consultancies enable row level security;
alter table consultancies force row level security;
create policy consultancies_select on consultancies for select using (auth.uid() is not null);
create policy consultancies_insert on consultancies for insert with check (is_admin());
create policy consultancies_update on consultancies for update using (is_admin()) with check (is_admin());

alter table leads add column consultancy_id uuid references consultancies(id);
alter table leads add column consultancy_other_name text;
