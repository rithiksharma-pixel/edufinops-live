-- =========================================================
-- RPC FUNCTIONS — DOCUMENT MANAGEMENT
-- =========================================================

create or replace function upload_document_record(
  p_lead_id uuid,
  p_document_type_id uuid,
  p_storage_path text,
  p_file_name text,
  p_file_size_bytes bigint,
  p_mime_type text,
  p_co_applicant_id uuid default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_document_id uuid;
begin
  insert into documents (lead_id, co_applicant_id, document_type_id, storage_path, file_name, file_size_bytes, mime_type, uploaded_by, created_by)
  values (p_lead_id, p_co_applicant_id, p_document_type_id, p_storage_path, p_file_name, p_file_size_bytes, p_mime_type, auth.uid(), auth.uid())
  returning id into v_document_id;

  insert into document_events (document_id, event_type, created_by)
  values (v_document_id, 'Uploaded', auth.uid());

  return v_document_id;
end;
$$;

create or replace function verify_document(p_document_id uuid, p_remarks text default null)
returns void
language plpgsql
security invoker
as $$
begin
  update documents
  set verification_status = 'Verified', verified_by = auth.uid(), verified_at = now(), remarks = p_remarks, updated_by = auth.uid()
  where id = p_document_id;
  if not found then raise exception 'Document % not found or not visible', p_document_id; end if;

  insert into document_events (document_id, event_type, remarks, created_by)
  values (p_document_id, 'Verified', p_remarks, auth.uid());
end;
$$;

create or replace function reject_document(p_document_id uuid, p_rejection_reason text)
returns void
language plpgsql
security invoker
as $$
begin
  update documents
  set verification_status = 'Rejected', verified_by = auth.uid(), verified_at = now(), rejection_reason = p_rejection_reason, updated_by = auth.uid()
  where id = p_document_id;
  if not found then raise exception 'Document % not found or not visible', p_document_id; end if;

  insert into document_events (document_id, event_type, remarks, created_by)
  values (p_document_id, 'Rejected', p_rejection_reason, auth.uid());
end;
$$;
