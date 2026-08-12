// =========================================================
// SERVICE LAYER — Consultant document upload.
//
// Same bucket, same metadata RPC and the same storage path convention as
// Lead Management's documentService.js — a file a Consultant uploads is
// indistinguishable from one an RM uploaded, and shows up in the RM's
// Documents tab immediately. The only difference is who is allowed to do
// it, which migration 036 opened up.
//
// Not imported from lead-management's copy on purpose: that module also
// pulls in verification and document-event helpers a Consultant has no
// policy for, and importing it would ship code that can only fail.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

const BUCKET = 'lead-documents';

export async function getDocumentTypes() {
  const { data, error } = await supabase
    .from('document_types')
    .select('id, name, category, applies_to')
    .eq('is_deleted', false)
    .order('sequence_order');
  if (error) throw error;
  return data;
}

export async function getDocumentsForLead(leadId) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, file_name, uploaded_at, verification_status, storage_path, document_types ( name, category )')
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Storage first, then the metadata row — matching Lead Management. If the
 * metadata insert fails the bytes are already in Storage, so the path is
 * surfaced in the error rather than the file being lost silently.
 */
export async function uploadDocument({ leadId, documentTypeId, file }) {
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
    p_co_applicant_id: null,
  });
  if (rpcError) {
    throw new Error(`File uploaded, but its record failed to save (path: ${path}): ${rpcError.message}`);
  }
}

export async function getDownloadUrl(storagePath) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 5);
  if (error) throw error;
  return data.signedUrl;
}
