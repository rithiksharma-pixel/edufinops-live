-- Run this once on an EXISTING project that predates this file.
-- =========================================================
-- Two RLS fixes from the code audit.
--
-- 1. Manager / Associate Team Manager could INSERT the four data-entry
--    detail tables (Academic / Family / Collateral / References /
--    University choices) but the UPDATE policy only allowed RM + Admin.
--    Result: a Manager's first save succeeded, every edit after silently
--    failed. The UPDATE policies are aligned to match the INSERT ones.
--
-- 2. A deal shared without a specific loan officer was invisible to the
--    ENTIRE lender org: can_view_deal only matched assigned_loan_officer_id
--    = auth.uid() (or bank_rm_id). Officer-optional sharing therefore
--    created black-hole deals. Adds an org-wide fallback that applies
--    ONLY when no officer is assigned — per-officer scoping is unchanged
--    the moment an officer is set.
-- =========================================================

-- ---------- 1. Manager/ATM can now edit, not just create ----------
do $$
declare t text;
begin
  foreach t in array array[
    'lead_academic_details','lead_parent_details','lead_collateral_details',
    'lead_references','lead_university_choices'
  ] loop
    execute format($f$
      alter policy %I_update on public.%I
      using (
        (select is_admin())
        or ((select is_manager()) and can_view_lead(lead_id))
        or ((select is_associate_team_manager()) and can_view_lead(lead_id))
        or ((select is_rm()) and can_view_lead(lead_id))
      )
      with check (
        (select is_admin())
        or ((select is_manager()) and can_view_lead(lead_id))
        or ((select is_associate_team_manager()) and can_view_lead(lead_id))
        or ((select is_rm()) and can_view_lead(lead_id))
      )
    $f$, t, t);
  end loop;
end $$;

-- ---------- 2. Officer-less deals visible to their lender org ----------
create or replace function public.can_view_deal(p_deal_id uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from deals d
    where d.id = p_deal_id
      and (
        is_admin()
        or (is_manager() and can_view_lead(d.lead_id))
        or (is_associate_team_manager() and can_view_lead(d.lead_id))
        or (is_rm() and can_view_lead(d.lead_id))
        or (is_counselor() and d.assigned_counselor_id = auth.uid())
        or (is_lender_side() and d.assigned_loan_officer_id = auth.uid())
        or (is_lender_side() and exists (
              select 1 from deal_bank_prospect_details bpd
              where bpd.deal_id = d.id and bpd.bank_rm_id = auth.uid()
            ))
        -- Officer-less deals fall back to org-wide visibility so a deal
        -- shared without a named officer isn't invisible to everyone.
        or (is_lender_side() and d.assigned_loan_officer_id is null
              and belongs_to_lender_org(d.lender_id))
      )
  )
$function$;
