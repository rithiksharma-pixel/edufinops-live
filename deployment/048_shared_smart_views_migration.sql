-- =========================================================
-- 048 — Smart views can be shared with the team
--
-- saved_views_select was user_id = auth.uid(), so a view was strictly
-- personal. An Admin screen for "creating smart views" would therefore have
-- been a private bookmark manager: nothing an Admin built could reach anyone.
--
-- is_shared makes a view part of the team's toolkit. Publishing one is an
-- Admin/Manager act, enforced in the policy rather than in the UI — otherwise
-- any RM could put a permanent tab on every colleague's screen.
--
-- VERIFIED by role simulation:
--   Admin  publish a SHARED view          ALLOWED
--   RM     publish a SHARED view          BLOCKED
--   RM     create own PRIVATE view        ALLOWED
--   RM     sees the Admin's shared view   1 row
--   RM2    sees another RM's private view 0 rows
-- =========================================================

alter table public.saved_views
  add column if not exists is_shared boolean not null default false;

create index if not exists idx_saved_views_shared on public.saved_views(is_shared) where is_shared;

-- Your own, plus anything published to the team.
drop policy if exists saved_views_select on public.saved_views;
create policy saved_views_select on public.saved_views for select
  using (user_id = (select auth.uid()) or is_shared);

-- Anyone may create their own. A SHARED row requires Admin/Manager.
drop policy if exists saved_views_insert on public.saved_views;
create policy saved_views_insert on public.saved_views for insert
  with check (
    user_id = (select auth.uid())
    and (not is_shared or (select is_admin_or_manager()))
  );

-- Edit your own. Admin/Manager may also edit any shared view, so a published
-- tab can be corrected or retired by someone other than its author.
drop policy if exists saved_views_update on public.saved_views;
create policy saved_views_update on public.saved_views for update
  using (user_id = (select auth.uid()) or (is_shared and (select is_admin_or_manager())))
  with check (
    (user_id = (select auth.uid()) or (is_shared and (select is_admin_or_manager())))
    and (not is_shared or (select is_admin_or_manager()))
  );
