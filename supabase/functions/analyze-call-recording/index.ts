// =========================================================
// EDGE FUNCTION — analyze-call-recording   ("Tangent Intelligence" phase 1)
// Deploy with: supabase functions deploy analyze-call-recording --no-verify-jwt
//
// Called from Postgres by dispatch_call_analysis() via pg_net when a row is
// inserted into call_recordings. pg_net carries no user JWT, so the Vault
// shared secret is the auth — same arrangement as send-notification-email,
// and it reuses the SAME secret so there is one thing to rotate, not two.
//
// Pipeline:  audio -> transcript -> structured analysis -> suggestions
//
// Extracted fields are written to call_field_suggestions, NEVER onto the
// lead. A human accepts each one in the drawer and apply_call_suggestion()
// does the typed write. That is deliberate: an LLM quietly rewriting
// university_name across 11,949 leads is not a failure mode worth risking,
// and the accept/reject record is the only honest accuracy signal we get.
//
// Required project secrets (`supabase secrets set NAME=value`):
//   NOTIFICATION_SECRET   must equal Vault's notification_secret
//   OPENAI_API_KEY        transcription (Whisper)
//   ANTHROPIC_API_KEY     analysis
// Optional:
//   CALL_ANALYSIS_MODEL   defaults to claude-sonnet-5
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// =========================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notification-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Whisper rejects anything over 25MB. Catch it here so the row fails with a
// message a human can act on rather than a raw 413 from someone else's API.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const EXTRACT_FIELDS = [
  'course_name', 'university_name', 'destination_country', 'intake_month',
  'intake_year', 'loan_amount_requested', 'admission_offer_status', 'loan_type',
];

// Forced tool call rather than "reply with JSON" — the model cannot answer in
// prose, so there is no parse step that can fail on a stray sentence.
const ANALYSIS_TOOL = {
  name: 'record_call_analysis',
  description: 'Record the structured analysis of an education-loan sales call.',
  input_schema: {
    type: 'object',
    properties: {
      detected_language: { type: 'string', description: 'e.g. "Hindi-English", "Telugu", "English"' },
      summary: { type: 'string', description: '3-5 sentences: what the student wants, what was agreed, what is blocking.' },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      next_actions: {
        type: 'array', items: { type: 'string' },
        description: 'Concrete follow-ups the RM committed to or should take.',
      },
      risk_flags: {
        type: 'array', items: { type: 'string' },
        description: 'Anything that could lose the deal or breach process: unanswered objection, wrong commitment on rate/eligibility, no next step agreed, student considering a competitor.',
      },
      extracted_fields: {
        type: 'array',
        description: 'Only fields ACTUALLY stated on the call. Omit anything inferred, assumed, or guessed from context.',
        items: {
          type: 'object',
          properties: {
            field_name: { type: 'string', enum: EXTRACT_FIELDS },
            value: { type: 'string', description: 'intake_month as 1-12; loan_amount_requested as a plain INR number, so "42 lakhs" is 4200000.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            evidence: { type: 'string', description: 'Short quote from the transcript supporting this.' },
          },
          required: ['field_name', 'value', 'confidence'],
        },
      },
    },
    required: ['summary', 'extracted_fields'],
  },
};

const SYSTEM_PROMPT = `You analyse recorded sales calls for an Indian education-loan company (Zolve Tangent).
Callers are relationship managers; the other party is a student or their parent.
Calls are usually a mix of English with Hindi, Telugu, Tamil, Kannada or Marathi, and the
transcript will be imperfect.

Rules:
- Extract a field ONLY if it is actually stated. Do not infer a university from a city,
  a country from a university, or an intake from a vague "next year". A missing field is
  far better than a wrong one, because a human has to trust these.
- Indian money terms: "lakh" = 100000, "crore" = 10000000. "42 lakhs" -> 4200000.
- intake_month is a number 1-12. "Fall"/"September intake" -> 9. "Spring"/"January" -> 1.
- If the transcript is too garbled or too short to judge, say so in the summary and
  return an empty extracted_fields array.
- Write the summary in plain English regardless of the call's language.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Names only, never values — this is how the missing NOTIFICATION_SECRET was
  // found last time without sending anything.
  if (req.method === 'GET' && new URL(req.url).searchParams.get('diag') === '1') {
    return json({ deployMarker: 'tangent-intelligence-v1', envKeys: Object.keys(Deno.env.toObject()).sort() });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expected = Deno.env.get('NOTIFICATION_SECRET');
  if (!expected || req.headers.get('x-notification-secret') !== expected) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let recordingId: string | null = null;
  try {
    ({ recording_id: recordingId } = await req.json());
    if (!recordingId) return json({ error: 'recording_id required' }, 400);

    const { data: rec, error: recErr } = await supabase
      .from('call_recordings').select('*').eq('id', recordingId).single();
    if (recErr || !rec) throw new Error(`Recording ${recordingId} not found`);

    await supabase.from('call_recordings').update({ status: 'processing' }).eq('id', recordingId);

    // ---------- 1. fetch the audio ----------
    const { data: signed, error: signErr } = await supabase.storage
      .from('call-recordings').createSignedUrl(rec.storage_path, 600);
    if (signErr || !signed) throw new Error(`Could not sign ${rec.storage_path}: ${signErr?.message}`);

    const audioRes = await fetch(signed.signedUrl);
    if (!audioRes.ok) throw new Error(`Audio download failed: HTTP ${audioRes.status}`);
    const audio = await audioRes.blob();
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new Error(`Recording is ${(audio.size / 1048576).toFixed(1)}MB; the 25MB limit is about 90 minutes of compressed audio. Split it or re-record at a lower bitrate.`);
    }

    // ---------- 2. transcribe ----------
    const form = new FormData();
    form.append('file', audio, rec.original_filename || 'call.m4a');
    form.append('model', 'whisper-1');
    // No `language` hint on purpose: these calls switch languages mid-sentence
    // and pinning one makes the other worse.
    const trRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}` },
      body: form,
    });
    if (!trRes.ok) throw new Error(`Transcription failed: HTTP ${trRes.status} ${await trRes.text()}`);
    const transcript: string = (await trRes.json()).text?.trim() ?? '';
    if (!transcript) throw new Error('Transcription returned nothing — the recording may be silent.');

    // ---------- 3. analyse ----------
    const model = Deno.env.get('CALL_ANALYSIS_MODEL') || 'claude-sonnet-5';
    const anRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: 'tool', name: 'record_call_analysis' },
        messages: [{ role: 'user', content: `Transcript of the call:\n\n${transcript}` }],
      }),
    });
    if (!anRes.ok) throw new Error(`Analysis failed: HTTP ${anRes.status} ${await anRes.text()}`);
    const anJson = await anRes.json();
    const toolUse = anJson.content?.find((c: { type: string }) => c.type === 'tool_use');
    if (!toolUse) throw new Error('Analysis returned no structured result');
    const a = toolUse.input;

    // ---------- 4. persist ----------
    await supabase.from('call_analyses').upsert({
      recording_id: recordingId,
      lead_id: rec.lead_id,
      transcript,
      detected_language: a.detected_language ?? null,
      summary: a.summary ?? null,
      next_actions: a.next_actions ?? [],
      risk_flags: a.risk_flags ?? [],
      sentiment: a.sentiment ?? null,
      transcription_model: 'whisper-1',
      analysis_model: model,
    }, { onConflict: 'recording_id' });

    // Re-running a recording must not stack duplicate chips on the drawer.
    await supabase.from('call_field_suggestions')
      .update({ status: 'superseded' })
      .eq('recording_id', recordingId).eq('status', 'pending');

    const suggestions = (a.extracted_fields ?? [])
      .filter((f: { field_name: string; value: string }) =>
        EXTRACT_FIELDS.includes(f.field_name) && String(f.value ?? '').trim() !== '')
      .map((f: { field_name: string; value: string; confidence: string; evidence?: string }) => ({
        recording_id: recordingId,
        lead_id: rec.lead_id,
        field_name: f.field_name,
        suggested_value: String(f.value).trim(),
        confidence: f.confidence ?? null,
        evidence: f.evidence ?? null,
      }));
    if (suggestions.length) {
      await supabase.from('call_field_suggestions').insert(suggestions);
    }

    await supabase.from('call_recordings')
      .update({ status: 'done', processed_at: new Date().toISOString(), error_message: null })
      .eq('id', recordingId);

    return json({ success: true, suggestions: suggestions.length, transcriptChars: transcript.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('analyze-call-recording failed:', message);
    // The row must carry its own failure — a silent 'processing' forever is
    // exactly the kind of hang that wastes a day to diagnose.
    if (recordingId) {
      await supabase.from('call_recordings')
        .update({ status: 'failed', error_message: message.slice(0, 500) })
        .eq('id', recordingId);
    }
    return json({ error: message }, 500);
  }
});
