// =========================================================
// SERVICE LAYER — Documents
// File bytes go to Supabase Storage (bucket: lead-documents);
// this file also records the metadata row via upload_document_record.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

const BUCKET = 'lead-documents';

export async function getDocumentTypes() {
  const { data, error } = await supabase
    .from('document_types')
    .select('id, name, applies_to, is_required')
    .eq('is_deleted', false)
    .order('sequence_order');
  if (error) throw error;
  return data;
}

export async function getDocumentsForLead(leadId) {
  const { data, error } = await supabase
    .from('documents')
    .select(`
      id, file_name, file_size_bytes, uploaded_at, verification_status, rejection_reason, remarks, storage_path,
      document_types ( name ),
      uploaded_by_user:users!documents_uploaded_by_fkey ( full_name ),
      co_applicants ( full_name )
    `)
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Uploads the file to Storage, then records its metadata via the
 * upload_document_record RPC. If the metadata insert fails after the
 * file already landed in Storage, we surface a distinct error — the
 * file isn't orphaned silently, but it also isn't tracked yet.
 */
export async function uploadDocument({ leadId, documentTypeId, file, coApplicantId, currentUserId }) {
  const path = `${leadId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file);
  if (uploadError) throw uploadError;

  const { error: rpcError } = await supabase.rpc('upload_document_record', {
    p_lead_id: leadId,
    p_document_type_id: documentTypeId,
    p_storage_path: path,
    p_file_name: file.name,
    p_file_size_bytes: file.size,
    p_mime_type: file.type,
    p_co_applicant_id: coApplicantId ?? null,
  });
  if (rpcError) {
    throw new Error(`File uploaded, but its record failed to save (path: ${path}): ${rpcError.message}`);
  }
}

export async function getDownloadUrl(storagePath) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 5); // 5 min
  if (error) throw error;
  return data.signedUrl;
}

export async function verifyDocument(documentId, remarks) {
  const { error } = await supabase.rpc('verify_document', { p_document_id: documentId, p_remarks: remarks ?? null });
  if (error) throw error;
}

export async function rejectDocument(documentId, reason) {
  const { error } = await supabase.rpc('reject_document', { p_document_id: documentId, p_rejection_reason: reason });
  if (error) throw error;
}
