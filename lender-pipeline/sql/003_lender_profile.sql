-- =========================================================
-- LENDER PIPELINE — bank profile details
-- Lets a Lender's own team update their institution's details
-- (previously `lenders` only had name/code, set up by Admin only).
-- =========================================================

alter table lenders add column if not exists contact_person_name text;
alter table lenders add column if not exists contact_email text;
alter table lenders add column if not exists contact_phone text;
alter table lenders add column if not exists registered_address text;
alter table lenders add column if not exists processing_notes text; -- e.g. "Sanctions typically take 5-7 business days"

-- Lender org members can update their OWN institution's profile;
-- Admin can update any. Reuses belongs_to_lender_org() from 002.
create policy lenders_update_own_org on lenders
  for update using (belongs_to_lender_org(id)) with check (belongs_to_lender_org(id));

-- GAP FOUND WHILE ADDING THE ABOVE: the original lenders SELECT policy
-- (lenders_select_non_consultant) never included Lender-role users at
-- all — meaning a Lender couldn't see their own institution's name,
-- even embedded via deals.lenders(name). Fixing it here.
create policy lenders_select_own_org on lenders
  for select using (belongs_to_lender_org(id));
