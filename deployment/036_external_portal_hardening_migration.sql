-- Run this once on an EXISTING project that predates this file.
-- Every statement is CREATE OR REPLACE / DROP-then-CREATE, so re-running is safe.
--
-- EXTERNAL PORTAL HARDENING + GAP FIXES
-- Findings and evidence: deployment/PORTAL_AUDIT.md
--
-- Fixes, in the order they appear below:
--   1  Lenders and Consultants could read the entire 811-row consultancy
--      channel roster, including which BD owns each. (High — data leak)
--   2  Every student name and loan amount rendered blank in the Lender
--      portal, because `leads` has no lender SELECT policy. (High — broken)
--   3  Lenders could not resolve any internal staff name, so message
--      threads would show no sender.
--   4  Consultants could not upload documents.
--   5  Consultants could not see lender-stage progress on their own student.
--
-- ---------------------------------------------------------------
-- A NOTE ON THE TWO SECURITY DEFINER VIEWS BELOW
-- ---------------------------------------------------------------
-- Migration 024 warns, correctly, that "a view runs as its OWNER by
-- default, which would bypass RLS and hand every lead to every user", and
-- every reporting view since has used security_invoker for that reason.
--
-- v_lender_deal_list and v_lender_milestones deliberately do the opposite,
-- because security_invoker cannot solve this problem: a lender has no
-- SELECT policy on `leads` at all, so an invoker view over `leads` returns
-- nothing no matter how it is written. The alternative — granting lenders
-- a policy on `leads` — would expose every column, including
-- aadhaar_number, pan_number and internal remarks. That is strictly worse.
--
-- So these two run as owner and carry their authorisation in an explicit,
-- non-negotiable WHERE clause:
--
--     where is_lender_side() and belongs_to_lender_org(d.lender_id)
--
-- Both helpers are existing SECURITY DEFINER functions that read
-- auth.uid(), which comes from the request JWT and is unaffected by the
-- view's execution role — so the predicate still identifies the real
-- caller. Both views are also declared `security_barrier = true`, which
-- stops Postgres pushing a caller-supplied function down below that
-- predicate and leaking rows it would have filtered.
--
-- The columns exposed are a strict SUBSET of what
-- get_lead_profile_for_lender() already returns to the same lender for the
-- same deals, so no new data reaches them — this only makes the list view
-- work without a blanket table policy.
-- =========================================================


-- =========================================================
-- 1. CONSULTANCY ROSTER — internal staff and BD only
--
-- Was: `using (auth.uid() is not null)` — every signed-in user of any
-- role, which handed all 811 partner names plus their BD owners to every
-- lender and consultant login.
--
-- is_internal_staff() alone is NOT sufficient here: it covers
-- Admin/Manager/ATM/RM/Counselor but NOT Business Development, and BD
-- users are routed to Lead Management (roleRoutes.js), whose
-- lookupService.js reads this table to populate the consultancy picker on
-- the New Lead form. Scoping to is_internal_staff() alone would break lead
-- creation for the BD team — the very people the roster is for.
--
-- Verified: neither consultant-portal/ nor lender-pipeline/ references
-- `consultancies` anywhere, so no external surface loses anything.
-- =========================================================
drop policy if exists consultancies_select on consultancies;

create policy consultancies_select on consultancies
  for select using (
    (select is_internal_staff())
    or (select auth_role()) = 'Business Development'
  );


-- =========================================================
-- 2. LENDER DEAL LIST — student name / amount for the pipeline table
--
-- Read the header note above before changing anything here: this view is
-- SECURITY DEFINER on purpose and its WHERE clause is the access control.
-- =========================================================
create or replace view v_lender_deal_list
with (security_barrier = true) as
select
  d.id                      as deal_id,
  d.lender_id,
  d.lead_id,
  l.student_name,
  l.student_phone,
  l.course_name,
  l.university_name,
  l.destination_country,
  l.loan_amount_requested,
  l.currency,
  ds.name                   as deal_stage,
  ds.sequence_order         as deal_stage_order,
  dss.name                  as deal_stage_status,
  rm.full_name              as assigned_rm,
  d.is_on_hold,
  d.is_rejected,
  d.total_disbursed_amount,
  d.created_at,
  d.updated_at
from deals d
join leads l                      on l.id = d.lead_id and l.is_deleted = false
left join deal_stages ds          on ds.id = d.current_deal_stage_id
left join deal_stage_statuses dss on dss.id = d.current_stage_status_id
left join users rm                on rm.id = l.assigned_rm_id
where d.is_deleted = false
  -- ↓ THIS IS THE ACCESS CONTROL. Do not remove or weaken.
  and (select is_lender_side())
  and belongs_to_lender_org(d.lender_id);

comment on view v_lender_deal_list is
  'Lender pipeline list: student + stage for deals shared with the caller''s own bank. SECURITY DEFINER + security_barrier by design — see 036 header. Columns are a subset of get_lead_profile_for_lender().';


-- =========================================================
-- 3. DEAL MESSAGE THREAD WITH SENDER NAMES
--
-- lender-pipeline's getMessages() selects `sender:users(full_name)`, but a
-- lender can read exactly one row of `users` — their own. Every message
-- from an internal RM would render with no sender.
--
-- Fixed with an RPC rather than a `users` SELECT policy: a policy is
-- row-level, so letting a lender see an RM's row would also expose that
-- RM's email and phone. This returns the name and nothing else.
--
-- Authorised by can_view_deal(), which already covers BOTH sides — the
-- lender org and the internal team — so the internal surface can move onto
-- the same function later without a second implementation.
-- =========================================================
create or replace function get_deal_messages(p_deal_id uuid)
returns table (
  id          uuid,
  message     text,
  created_at  timestamptz,
  sender_id   uuid,
  sender_name text,
  sender_side text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not coalesce(can_view_deal(p_deal_id), false) then
    raise exception 'Not authorized to view messages on this deal';
  end if;

  return query
  select m.id, m.message, m.created_at, m.sender_id,
         u.full_name,
         case when r.name = 'Lender' then 'lender' else 'internal' end
  from lender_deal_messages m
  left join users u on u.id = m.sender_id
  left join roles r on r.id = u.role_id
  where m.deal_id = p_deal_id and m.is_deleted = false
  order by m.created_at;
end;
$function$;

comment on function get_deal_messages(uuid) is
  'Deal message thread with sender names resolved. Authorised by can_view_deal(), so it serves the lender org and the internal team alike.';


-- =========================================================
-- 4. CONSULTANT DOCUMENT UPLOAD
--
-- Consultants submit a student and then cannot attach the passport, offer
-- letter or marksheets — those arrive by WhatsApp and get uploaded
-- internally, which is the manual step the portal exists to remove.
--
-- Three separate gates had to open, which is why this never half-worked:
--   documents_insert          the metadata row
--   lead_documents_insert     the file bytes (storage.objects)
--   lead_documents_select     downloading back what they uploaded
--
-- can_view_lead() already returns true for a source role on their OWN
-- lead, so scoping is inherited rather than reinvented — a consultant
-- still cannot touch anyone else's student.
--
-- upload_document_record() is NOT security definer and relies on these
-- policies, and document_events_insert already cascades from
-- can_view_lead(), so no change is needed there.
-- =========================================================
drop policy if exists documents_insert on documents;

create policy documents_insert on documents
  for insert with check (
    is_admin()
    or (is_manager() and can_view_lead(lead_id))
    or (is_associate_team_manager() and can_view_lead(lead_id))
    or (is_rm() and can_view_lead(lead_id))
    or (is_counselor() and can_view_lead(lead_id))
    -- NEW: Consultant / Business Development, on their own sourced leads only.
    or ((select is_source_role()) and can_view_lead(lead_id))
  );

alter policy lead_documents_insert on storage.objects
  with check (
    bucket_id = 'lead-documents'
    and (
      is_admin()
      or (is_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_associate_team_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_rm() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_counselor() and can_view_lead((storage.foldername(name))[1]::uuid))
      or ((select is_source_role()) and can_view_lead((storage.foldername(name))[1]::uuid))
    )
  );

alter policy lead_documents_select on storage.objects
  using (
    bucket_id = 'lead-documents'
    and (
      is_admin()
      or (is_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_associate_team_manager() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_rm() and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_counselor() and can_view_lead((storage.foldername(name))[1]::uuid))
      or ((select is_source_role()) and can_view_lead((storage.foldername(name))[1]::uuid))
      or (is_lender_side() and exists (
            select 1 from deals d
            where d.lead_id = (storage.foldername(objects.name))[1]::uuid
              and can_view_deal(d.id)
          ))
    )
  );


-- =========================================================
-- 5. LENDER PROGRESS FOR THE SOURCING CONSULTANT
--
-- A Consultant gets zero rows from `deals`, so "Lead status" shows the
-- lead stage only — not which banks their student went to or where each
-- one stands. It is the single thing consultants phone RMs about.
--
-- Deliberately narrow: bank name, branch, stage, and hold/reject flags.
-- No sanction amounts, no interest rates, no internal remarks, no other
-- students. `lenders` is not readable by a source role at all
-- (lenders_select_non_consultant excludes them), which is why the bank
-- name has to come through a definer function rather than a join.
--
-- Authorised by can_view_lead(), so a consultant sees this for their own
-- sourced students and nobody else's.
-- =========================================================
create or replace function get_lead_lender_progress(p_lead_id uuid)
returns table (
  deal_id        uuid,
  lender_name    text,
  branch_name    text,
  deal_stage     text,
  stage_order    integer,
  stage_status   text,
  is_on_hold     boolean,
  is_rejected    boolean,
  login_date     date,
  sanction_date  date,
  pf_date        date,
  last_updated   timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not coalesce(can_view_lead(p_lead_id), false) then
    raise exception 'Not authorized to view this lead';
  end if;

  return query
  select
    d.id, ln.name, lb.name, ds.name, ds.sequence_order, dss.name,
    d.is_on_hold, d.is_rejected,
    dl.login_date, sn.sanction_date, pf.pf_date,
    d.updated_at
  from deals d
  left join lenders ln              on ln.id = d.lender_id
  left join lender_branches lb      on lb.id = d.lender_branch_id
  left join deal_stages ds          on ds.id = d.current_deal_stage_id
  left join deal_stage_statuses dss on dss.id = d.current_stage_status_id
  left join deal_login_details dl    on dl.deal_id = d.id and dl.is_deleted = false
  left join deal_sanction_details sn on sn.deal_id = d.id and sn.is_deleted = false
  left join deal_pf_details pf       on pf.deal_id = d.id and pf.is_deleted = false
  where d.lead_id = p_lead_id and d.is_deleted = false
  order by ds.sequence_order desc nulls last, ln.name;
end;
$function$;

comment on function get_lead_lender_progress(uuid) is
  'Bank-by-bank progress on one lead for whoever can already see it — including the sourcing Consultant, who has no access to `deals`. Stage only: no amounts, rates or internal remarks.';
