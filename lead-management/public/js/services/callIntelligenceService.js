// =========================================================
// SERVICE LAYER — Tangent Intelligence (call recordings)
//
// Upload -> the DB trigger dispatches the Edge Function -> transcript,
// summary and field suggestions come back on the row. Nothing here calls
// an AI provider directly; the browser never sees an API key.
//
// RLS scopes every read to leads the caller can already see. Suggestions
// are inserted only by the Edge Function (service_role) — there is no
// INSERT policy for end users on purpose, so nothing in the browser can
// fabricate a suggestion and then "accept" it.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

/** Anything a phone or a dictaphone realistically produces. */
export const ACCEPTED_AUDIO = ['.m4a', '.mp3', '.wav', '.ogg', '.opus', '.webm', '.mp4', '.aac', '.amr'];
/** Whisper's own ceiling. Rejected here so the user finds out before a
 *  five-minute upload rather than after it. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const FIELD_LABELS = {
  course_name: 'Course',
  university_name: 'University',
  destination_country: 'Country',
  intake_month: 'Intake month',
  intake_year: 'Intake year',
  loan_amount_requested: 'Loan amount',
  admission_offer_status: 'Admission status',
  loan_type: 'Loan type',
};

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Renders a raw suggested value the way a person would read it. */
export function displayValue(field, value) {
  if (field === 'intake_month') return MONTHS[Number(value)] || value;
  if (field === 'loan_amount_requested') {
    const n = Number(value);
    return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : value;
  }
  return value;
}

export async function listRecordings(leadId) {
  const { data, error } = await supabase
    .from('call_recordings')
    .select(`
      id, original_filename, status, error_message, created_at, processed_at, size_bytes,
      uploaded_by_user:users!call_recordings_uploaded_by_fkey ( full_name ),
      call_analyses ( transcript, summary, detected_language, sentiment, next_actions, risk_flags, analysis_model )
    `)
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listSuggestions(leadId) {
  const { data, error } = await supabase
    .from('call_field_suggestions')
    .select('id, recording_id, field_name, suggested_value, confidence, evidence, status')
    .eq('lead_id', leadId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Uploads the audio, then inserts the row that triggers analysis.
 *
 * Order matters: the storage object must exist before the row, because the
 * insert trigger fires immediately and the Edge Function's first move is to
 * sign a URL for that path. Row-first would race and fail on a missing file.
 */
export async function uploadRecording(leadId, file) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (!ACCEPTED_AUDIO.includes(ext)) {
    throw new Error(`${ext || 'That file type'} isn't a supported audio format.`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`That file is ${(file.size / 1048576).toFixed(1)}MB. The limit is 25MB — roughly 90 minutes of compressed audio.`);
  }

  // Foldered by lead id because the storage RLS policy reads folder[1] as the
  // lead and checks can_view_lead() against it.
  const safe = file.name.replace(/[^a-z0-9.\-_]/gi, '_').slice(-80);
  const path = `${leadId}/${Date.now()}-${safe}`;

  const { error: upErr } = await supabase.storage
    .from('call-recordings')
    .upload(path, file, { contentType: file.type || 'audio/mpeg', upsert: false });
  if (upErr) throw upErr;

  const { data, error } = await supabase
    .from('call_recordings')
    .insert({
      lead_id: leadId,
      storage_path: path,
      original_filename: file.name,
      size_bytes: file.size,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

export async function acceptSuggestion(suggestionId) {
  const { error } = await supabase.rpc('apply_call_suggestion', { p_suggestion_id: suggestionId });
  if (error) throw error;
}

export async function rejectSuggestion(suggestionId) {
  const { error } = await supabase
    .from('call_field_suggestions')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', suggestionId);
  if (error) throw error;
}

export async function getPlaybackUrl(recordingId) {
  const { data: rec, error } = await supabase
    .from('call_recordings').select('storage_path').eq('id', recordingId).single();
  if (error) throw error;
  const { data, error: sErr } = await supabase.storage
    .from('call-recordings').createSignedUrl(rec.storage_path, 3600);
  if (sErr) throw sErr;
  return data.signedUrl;
}
