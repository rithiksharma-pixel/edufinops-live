// =========================================================
// PRESENTATION LAYER — Tangent Intelligence tab
//
// Upload a recording, watch it process, read the summary, and accept or
// reject the fields it pulled out.
//
// The suggestion chips are the point of this screen. Course, university and
// intake are near-empty across the pipeline (intake is empty on every single
// lead) because nobody types them after a call. One tap to accept is the
// whole design goal — anything slower and it will not get used.
// =========================================================
import {
  listRecordings, listSuggestions, uploadRecording, acceptSuggestion,
  rejectSuggestion, getPlaybackUrl, displayValue,
  FIELD_LABELS, ACCEPTED_AUDIO, MAX_UPLOAD_BYTES,
} from '../services/callIntelligenceService.js';
import { escapeHtml } from '../../../../shared/js/utils.js';

/** Processing is async, so poll while anything is in flight — but stop, so a
 *  drawer left open overnight isn't hammering the database. */
const POLL_MS = 4000;
const POLL_LIMIT = 45;   // ~3 minutes

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN',
    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL = {
  pending: 'Queued',
  processing: 'Transcribing and analysing…',
  done: 'Analysed',
  failed: 'Failed',
};

function suggestionsHtml(suggestions) {
  if (!suggestions.length) return '';
  return `
    <div class="ti-suggest">
      <div class="ti-suggest-head">
        <strong>${suggestions.length} field${suggestions.length === 1 ? '' : 's'} found on the call</strong>
        <span>Nothing is written to the lead until you accept it.</span>
      </div>
      ${suggestions.map((s) => `
        <div class="ti-chip" data-sid="${s.id}">
          <div class="ti-chip-main">
            <span class="ti-chip-field">${escapeHtml(FIELD_LABELS[s.field_name] || s.field_name)}</span>
            <span class="ti-chip-value">${escapeHtml(displayValue(s.field_name, s.suggested_value))}</span>
            ${s.confidence ? `<span class="ti-conf ti-conf-${escapeHtml(s.confidence)}">${escapeHtml(s.confidence)}</span>` : ''}
          </div>
          ${s.evidence ? `<div class="ti-chip-evidence">“${escapeHtml(s.evidence)}”</div>` : ''}
          <div class="ti-chip-actions">
            <button class="btn btn-primary btn-sm" data-accept="${s.id}">Accept</button>
            <button class="btn btn-ghost btn-sm" data-reject="${s.id}">Dismiss</button>
          </div>
        </div>`).join('')}
    </div>`;
}

function recordingHtml(r) {
  const a = Array.isArray(r.call_analyses) ? r.call_analyses[0] : r.call_analyses;
  const actions = a?.next_actions || [];
  const risks = a?.risk_flags || [];

  return `
    <div class="ti-rec" data-rid="${r.id}">
      <div class="ti-rec-head">
        <div>
          <strong>${escapeHtml(r.original_filename || 'Recording')}</strong>
          <span class="ti-rec-meta">${when(r.created_at)}${
            r.uploaded_by_user?.full_name ? ` · ${escapeHtml(r.uploaded_by_user.full_name)}` : ''}</span>
        </div>
        <span class="ti-status ti-status-${r.status}">${STATUS_LABEL[r.status] || r.status}</span>
      </div>

      ${r.status === 'failed' ? `
        <p class="ti-error">${escapeHtml(r.error_message || 'Analysis failed.')}</p>` : ''}

      ${a?.summary ? `
        <p class="ti-summary">${escapeHtml(a.summary)}</p>
        <div class="ti-meta-row">
          ${a.detected_language ? `<span>${escapeHtml(a.detected_language)}</span>` : ''}
          ${a.sentiment ? `<span class="ti-sent ti-sent-${escapeHtml(a.sentiment)}">${escapeHtml(a.sentiment)}</span>` : ''}
        </div>` : ''}

      ${actions.length ? `
        <div class="ti-list"><span class="ti-list-h">Next actions</span>
          <ul>${actions.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}

      ${risks.length ? `
        <div class="ti-list ti-list-risk"><span class="ti-list-h">Worth a look</span>
          <ul>${risks.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}

      <div class="ti-rec-actions">
        <button class="btn btn-ghost btn-sm" data-play="${r.id}"><i class="fa-solid fa-play"></i> Listen</button>
        ${a?.transcript ? `<button class="btn btn-ghost btn-sm" data-transcript="${r.id}">Transcript</button>` : ''}
      </div>
      <div class="ti-player" data-player="${r.id}" hidden></div>
      ${a?.transcript ? `<pre class="ti-transcript" data-tx="${r.id}" hidden>${escapeHtml(a.transcript)}</pre>` : ''}
    </div>`;
}

export async function initCallIntelligenceTab(panelEl, leadId, { showToast, onLeadUpdated } = {}) {
  let pollTimer = null;
  let polls = 0;

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  async function refresh() {
    let recordings = [];
    let suggestions = [];
    try {
      [recordings, suggestions] = await Promise.all([listRecordings(leadId), listSuggestions(leadId)]);
    } catch (err) {
      console.error('Tangent Intelligence load failed', err);
      panelEl.innerHTML = `<p class="empty-state">Could not load call intelligence.<br>
        <span style="font-size:12px;">${escapeHtml(err?.message || String(err))}</span></p>`;
      return;
    }

    panelEl.innerHTML = `
      <div class="ti-wrap">
        <div class="ti-upload">
          <label class="btn btn-primary" for="tiFile">
            <i class="fa-solid fa-microphone-lines"></i> Upload a call recording
          </label>
          <input type="file" id="tiFile" accept="${ACCEPTED_AUDIO.join(',')}" hidden />
          <span class="ti-upload-hint">Up to ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB. Transcribed, summarised, and read for course, university, intake and amount.</span>
          <div class="ti-progress" id="tiProgress" hidden></div>
        </div>

        ${suggestionsHtml(suggestions)}

        ${recordings.length
          ? `<div class="ti-recs">${recordings.map(recordingHtml).join('')}</div>`
          : '<p class="empty-state">No recordings yet. Upload one after a call and it will be summarised here.</p>'}
      </div>`;

    wire(recordings);

    // Keep refreshing only while something is actually in flight.
    const busy = recordings.some((r) => r.status === 'pending' || r.status === 'processing');
    stopPolling();
    if (busy && polls < POLL_LIMIT) {
      polls += 1;
      pollTimer = setTimeout(refresh, POLL_MS);
    }
  }

  function wire(recordings) {
    const fileInput = panelEl.querySelector('#tiFile');
    const progress = panelEl.querySelector('#tiProgress');

    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      progress.hidden = false;
      progress.innerHTML = '<span class="spinner"></span> Uploading…';
      try {
        await uploadRecording(leadId, file);
        polls = 0;                       // a new upload earns a fresh poll budget
        showToast?.('Uploaded — analysing now.');
        await refresh();
      } catch (err) {
        console.error('upload failed', err);
        progress.innerHTML = `<span class="ti-error">${escapeHtml(err?.message || String(err))}</span>`;
        showToast?.(err?.message || 'Upload failed', true);
      } finally {
        fileInput.value = '';            // so re-picking the same file re-fires change
      }
    });

    panelEl.querySelectorAll('[data-accept]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await acceptSuggestion(btn.dataset.accept);
          showToast?.('Applied to the lead.');
          onLeadUpdated?.();             // refresh the drawer header and the list behind it
          await refresh();
        } catch (err) {
          btn.disabled = false;
          console.error('accept failed', err);
          // The RPC raises a readable message on a bad value — surface it
          // rather than a generic failure, because it names the actual problem.
          showToast?.(err?.message || 'Could not apply that value', true);
        }
      });
    });

    panelEl.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rejectSuggestion(btn.dataset.reject);
          await refresh();
        } catch (err) {
          btn.disabled = false;
          showToast?.(err?.message || 'Could not dismiss that', true);
        }
      });
    });

    panelEl.querySelectorAll('[data-transcript]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pre = panelEl.querySelector(`[data-tx="${btn.dataset.transcript}"]`);
        if (pre) pre.hidden = !pre.hidden;
      });
    });

    panelEl.querySelectorAll('[data-play]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const host = panelEl.querySelector(`[data-player="${btn.dataset.play}"]`);
        if (!host) return;
        if (!host.hidden) { host.hidden = true; host.innerHTML = ''; return; }
        host.hidden = false;
        host.innerHTML = '<span class="spinner"></span>';
        try {
          const url = await getPlaybackUrl(btn.dataset.play);
          host.innerHTML = `<audio controls preload="none" src="${escapeHtml(url)}" style="width:100%"></audio>`;
        } catch (err) {
          host.innerHTML = `<span class="ti-error">${escapeHtml(err?.message || 'Could not load audio')}</span>`;
        }
      });
    });

    void recordings;
  }

  await refresh();
  return { refresh, destroy: stopPolling };
}
