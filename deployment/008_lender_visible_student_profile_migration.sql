-- Run this once on an EXISTING project that predates this file. Fresh
-- projects already get this from 000_master_migration.sql.
--
-- Lenders get everything relevant to underwriting (personal/ID/address/
-- employment/academic/family/collateral/references/co-applicants/
-- documents) EXCEPT: the CRM's internal pipeline stage, the other-
-- lenders share matrix, and the RM team's internal logs. Implemented as
-- a SECURITY DEFINER RPC gated on can_view_deal() rather than opening
-- the base `leads` table's RLS to lenders directly.

create or replace function get_lead_profile_for_lender(p_deal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_result jsonb;
begin
  if not (coalesce(is_lender_side(), false) and can_view_deal(p_deal_id)) then
    raise exception 'Not authorized to view this deal''s lead profile';
  end if;

  select lead_id into v_lead_id from deals where id = p_deal_id;

  select jsonb_build_object(
    'lead', (
      select to_jsonb(l) - 'current_stage_id' - 'assigned_manager_id' - 'source_user_id'
        - 'lead_source_id' - 'priority' - 'next_follow_up_at' - 'last_activity_at'
        - 'is_duplicate_flag' - 'duplicate_of_lead_id' - 'created_by' - 'updated_by'
        - 'created_at' - 'updated_at' - 'is_deleted' - 'status'
        - 'consultancy_id' - 'consultancy_other_name'
        || jsonb_build_object('assigned_rm_name', (select full_name from users where id = l.assigned_rm_id))
      from leads l where l.id = v_lead_id
    ),
    'co_applicants', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from co_applicants c where c.lead_id = v_lead_id and c.is_deleted = false),
    'university_choices', (select coalesce(jsonb_agg(to_jsonb(u) order by u.sequence_order), '[]'::jsonb) from lead_university_choices u where u.lead_id = v_lead_id and u.is_deleted = false),
    'academic', (select to_jsonb(a) from lead_academic_details a where a.lead_id = v_lead_id and a.is_deleted = false),
    'parents', (select to_jsonb(p) from lead_parent_details p where p.lead_id = v_lead_id and p.is_deleted = false),
    'collateral', (select coalesce(jsonb_agg(to_jsonb(col)), '[]'::jsonb) from lead_collateral_details col where col.lead_id = v_lead_id and col.is_deleted = false),
    'references', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from lead_references r where r.lead_id = v_lead_id and r.is_deleted = false),
    'documents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'file_name', d.file_name, 'storage_path', d.storage_path,
        'document_type', dt.name, 'verification_status', d.verification_status,
        'uploaded_at', d.uploaded_at
      )), '[]'::jsonb)
      from documents d join document_types dt on dt.id = d.document_type_id
      where d.lead_id = v_lead_id and d.is_deleted = false
    )
  ) into v_result;

  return v_result;
end;
$$;

alter policy lead_documents_select on storage.objects
  using (
    bucket_id = 'lead-documents'
    and (
      public.is_admin()
      or (public.is_manager() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_rm() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_counselor() and public.can_view_lead((storage.foldername(name))[1]::uuid))
      or (public.is_lender_side() and exists (
            select 1 from deals d
            where d.lead_id = (storage.foldername(name))[1]::uuid
              and public.can_view_deal(d.id)
          ))
    )
  );
