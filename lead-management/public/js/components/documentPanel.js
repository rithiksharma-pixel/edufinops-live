// =========================================================
// PRESENTATION LAYER — Documents tab (inside the lead detail drawer)
//
// Opens with a five-stage progress meter, because the question an RM
// actually has here is "how far along is this file?" — not "what has
// been uploaded?", which is all the old wall of upload lists could
// answer. The five stages are the (applies_to, category) cells of
// document_types that the business works through; see PROGRESS_STAGES.
//
// Below the meter, one section per "owner" — the Student, then one per
// co-applicant on this lead (labeled by their relationship, e.g.
// "Father — Ramesh Sharma") — since a parent here IS a co-applicant
// (relationship_to_student = Father/Mother), not a separate entity.
// Within each owner, documents are grouped into KYC / Academics /
// Financials / Other (document_types.category); a category only renders
// if that owner has at least one document type configured for it, so an
// owner with no Academics-category types configured just doesn't show
// that heading. Each owner's upload form accepts multiple files at once,
// applied under the same document type for the whole batch.
// =========================================================
import { getDocumentTypes, getDocumentsForLead, uploadDocument, getDownloadUrl, verifyDocument, rejectDocument } from '../services/documentService.js';
import { formatDateTime } from '../utils/validation.js';
import { emptyState } from '../../../../shared/js/emptyState.js';
import { escapeHtml } from '../../../../shared/js/utils.js';

const CATEGORY_ORDER = ['KYC', 'Academics', 'Financials', 'Other'];

// The meter's segments, in the order a file gets worked. Each is one
// cell of the document_types taxonomy — `scope` picks the applies_to
// values, `category` the category — so nothing here is a second,
// drifting definition of what a stage contains.
//
// Deliberately a fixed list rather than "whatever cells exist": these
// five are the stages the business commits to, and a stage with no
// document types configured yet still has to appear (as "not set up")
// instead of silently vanishing from the progress picture.
const PROGRESS_STAGES = [
  { key: 'student-kyc', label: 'Student KYC', scope: 'student', category: 'KYC' },
  { key: 'student-financials', label: 'Student Financials', scope: 'student', category: 'Financials' },
  { key: 'student-academics', label: 'Student Academics', scope: 'student', category: 'Academics' },
  { key: 'coapp-kyc', label: 'Co-App KYC', scope: 'coapp', category: 'KYC' },
  { key: 'coapp-financials', label: 'Co-App Financials', scope: 'coapp', category: 'Financials' },
];

const SCOPE_APPLIES_TO = { student: ['Student', 'Both'], coapp: ['Co-applicant', 'Both'] };

const SLOT_ICON = { verified: 'fa-circle-check', pending: 'fa-clock', rejected: 'fa-circle-xmark', missing: 'fa-circle' };
const SLOT_TEXT = { verified: 'Verified', pending: 'Awaiting review', rejected: 'Rejected — re-upload needed', missing: 'Not uploaded' };

export async function initDocumentsTab(panelEl, leadId, ctx) {
  const { currentUser, showToast, coApplicants } = ctx;

  // Which meter segment's checklist is expanded. Held outside refresh()
  // so an upload (which re-renders everything) doesn't collapse it.
  let openStageKey = null;

  function owners() {
    return [
      { key: 'student', label: 'Student', coApplicantId: null, appliesTo: SCOPE_APPLIES_TO.student },
      ...(coApplicants || []).map((c) => ({
        key: c.id,
        label: `${c.relationship_to_student} — ${c.full_name}`,
        coApplicantId: c.id,
        appliesTo: SCOPE_APPLIES_TO.coapp,
      })),
    ];
  }

  async function refresh() {
    const [docTypes, docs] = await Promise.all([getDocumentTypes(), getDocumentsForLead(leadId)]);
    const ownerList = owners();
    const stages = PROGRESS_STAGES.map((stage) => measureStage(stage, ownerList, docTypes, docs));

    panelEl.innerHTML = `
      <div class="doc-meter" id="docMeter"></div>
      ${ownerList.map((owner) => renderOwnerSection(owner, docTypes)).join('')}
    `;
    renderMeter(stages);

    ownerList.forEach((owner) => {
      const typesForOwner = docTypes.filter((t) => owner.appliesTo.includes(t.applies_to));
      if (typesForOwner.length === 0) return; // no upload form was rendered for this owner
      wireUploadForm(owner);
      CATEGORY_ORDER.forEach((cat) => {
        if (!typesForOwner.some((t) => t.category === cat)) return;
        const docsInCat = docs.filter((d) => (d.co_applicant_id || null) === owner.coApplicantId && d.document_types?.category === cat);
        renderDocList(document.getElementById(`docList-${owner.key}-${cat}`), docsInCat);
      });
    });

    function renderMeter(measured) {
      const meterEl = document.getElementById('docMeter');
      meterEl.innerHTML = meterHtml(measured, openStageKey);
      meterEl.querySelectorAll('.doc-meter-seg').forEach((btn) => {
        btn.addEventListener('click', () => {
          openStageKey = openStageKey === btn.dataset.stage ? null : btn.dataset.stage;
          renderMeter(measured);
        });
      });
      meterEl.querySelector('[data-action="jump"]')?.addEventListener('click', (e) => {
        document.getElementById(e.currentTarget.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  function renderOwnerSection(owner, docTypes) {
    const typesForOwner = docTypes.filter((t) => owner.appliesTo.includes(t.applies_to));
    const categoriesPresent = CATEGORY_ORDER.filter((cat) => typesForOwner.some((t) => t.category === cat));

    if (typesForOwner.length === 0) {
      return `
        <div class="deal-section">
          <div class="deal-section-label">${escapeHtml(owner.label)}</div>
          <p class="empty-state" style="padding:8px 0;">No document types configured for this yet — add some in Admin Settings.</p>
        </div>
      `;
    }

    const typeOptionsHtml = categoriesPresent.map((cat) => `
      <optgroup label="${escapeHtml(cat)}">
        ${typesForOwner.filter((t) => t.category === cat).map((t) => `<option value="${t.id}">${escapeHtml(t.name)}${t.is_required ? ' *' : ''}</option>`).join('')}
      </optgroup>
    `).join('');

    const categoryBlocksHtml = categoriesPresent.map((cat) => `
      <div class="deal-section-label" style="margin:16px 0 8px;">${escapeHtml(owner.label)} · ${escapeHtml(cat)}</div>
      <div id="docList-${owner.key}-${cat}"></div>
    `).join('');

    return `
      <div class="deal-section">
        <div class="deal-section-label">${escapeHtml(owner.label)}</div>
        <div class="form-field"><label>Document type</label><select id="typeSelect-${owner.key}">${typeOptionsHtml}</select></div>
        <div class="form-field"><label>Files</label><input type="file" id="fileInput-${owner.key}" multiple /></div>
        <button class="btn btn-primary" id="uploadBtn-${owner.key}" style="width:100%;justify-content:center;">Upload</button>
      </div>
      ${categoryBlocksHtml}
    `;
  }

  function wireUploadForm(owner) {
    document.getElementById(`uploadBtn-${owner.key}`).addEventListener('click', async () => {
      const fileInput = document.getElementById(`fileInput-${owner.key}`);
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) { showToast('Choose at least one file.', true); return; }
      const documentTypeId = document.getElementById(`typeSelect-${owner.key}`).value;

      const btn = document.getElementById(`uploadBtn-${owner.key}`);
      btn.disabled = true;
      let uploaded = 0;
      let failed = 0;
      for (const file of files) {
        btn.textContent = files.length > 1 ? `Uploading ${uploaded + failed + 1} of ${files.length}…` : 'Uploading…';
        try {
          await uploadDocument({ leadId, documentTypeId, file, coApplicantId: owner.coApplicantId, currentUserId: currentUser.id });
          uploaded++;
        } catch (err) {
          failed++;
        }
      }
      showToast(
        failed === 0 ? `Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}.` : `Uploaded ${uploaded}, ${failed} failed.`,
        failed > 0
      );
      btn.disabled = false;
      btn.textContent = 'Upload';
      await refresh();
    });
  }

  function renderDocList(listEl, docs) {
    if (!listEl) return;
    if (docs.length === 0) {
      listEl.innerHTML = emptyState('fa-folder-open', 'No documents uploaded yet', 'Use the upload form above to add the first one.');
      return;
    }
    listEl.innerHTML = docs.map((d) => {
      const statusBadgeClass = d.verification_status === 'Verified' ? 'badge-success' : d.verification_status === 'Rejected' ? 'badge-danger' : 'badge-warning';
      return `
        <div class="lender-app-card" data-doc-id="${d.id}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div class="lender-name">${escapeHtml(d.document_types?.name || 'Document')}</div>
              <div style="font-size:12px;color:var(--ink-500);">${escapeHtml(d.file_name)} · ${formatDateTime(d.uploaded_at)} · ${escapeHtml(d.uploaded_by_user?.full_name || '–')}</div>
            </div>
            <span class="badge ${statusBadgeClass}">${escapeHtml(d.verification_status)}</span>
          </div>
          ${d.rejection_reason ? `<div class="detail-row"><span class="k">Rejection reason</span><span class="v">${escapeHtml(d.rejection_reason)}</span></div>` : ''}
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px;" data-action="download">Download</button>
            ${d.verification_status === 'Pending Review' ? `
              <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px;" data-action="verify">Verify</button>
              <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px;color:var(--danger);" data-action="reject">Reject</button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('[data-doc-id]').forEach((card) => {
      const doc = docs.find((d) => d.id === card.dataset.docId);
      card.querySelector('[data-action="download"]')?.addEventListener('click', async () => {
        try {
          const url = await getDownloadUrl(doc.storage_path);
          window.open(url, '_blank');
        } catch (err) {
          showToast('Could not generate a download link.', true);
        }
      });
      card.querySelector('[data-action="verify"]')?.addEventListener('click', async () => {
        try {
          await verifyDocument(doc.id, null);
          showToast('Document verified.');
          await refresh();
        } catch (err) {
          showToast('Could not verify this document.', true);
        }
      });
      card.querySelector('[data-action="reject"]')?.addEventListener('click', async () => {
        const reason = prompt('Reason for rejecting this document:');
        if (!reason) return;
        try {
          await rejectDocument(doc.id, reason);
          showToast('Document rejected.');
          await refresh();
        } catch (err) {
          showToast('Could not reject this document.', true);
        }
      });
    });
  }

  await refresh();
}

// ---------------------------------------------------------
// Progress measurement — pure functions over the two fetches.
// ---------------------------------------------------------

/**
 * One (owner × document type) pair is one "slot" — the unit of progress.
 * A slot's state is the best status among its documents, because a
 * re-upload after a rejection has to be able to clear the stage: one
 * Verified copy means done regardless of what was rejected before it.
 */
function measureSlot(owner, type, docs) {
  const forSlot = docs.filter((d) => (d.co_applicant_id || null) === owner.coApplicantId && d.document_type_id === type.id);
  const state = forSlot.some((d) => d.verification_status === 'Verified') ? 'verified'
    : forSlot.some((d) => d.verification_status === 'Pending Review') ? 'pending'
      : forSlot.length > 0 ? 'rejected' : 'missing';
  return { ownerLabel: owner.label, ownerKey: owner.key, typeName: type.name, required: !!type.is_required, state };
}

/**
 * Turns one PROGRESS_STAGES entry into countable slots.
 *
 * `blocked` marks a stage that has nothing to measure, and the caller
 * must render that differently from 0% — a stage nobody has configured,
 * or a co-applicant stage on a lead with no co-applicant, is not a lead
 * that's behind on paperwork, and showing it as an empty bar would send
 * an RM chasing documents that don't exist.
 */
function measureStage(stage, ownerList, docTypes, docs) {
  const ownersInScope = ownerList.filter((o) => (stage.scope === 'student') === (o.coApplicantId === null));
  const types = docTypes.filter((t) => t.category === stage.category && SCOPE_APPLIES_TO[stage.scope].includes(t.applies_to));

  // Only required types count toward the bar, so a stage can actually
  // reach 100%: Property Documents and an English test score are
  // "if it applies" papers, and counting them would pin an otherwise
  // finished stage below full forever. Optional uploads are still shown
  // in the checklist, just under the count. A stage with nothing marked
  // required falls back to all of its types so it still measures
  // something rather than reading as instantly complete.
  const required = types.filter((t) => t.is_required);
  const counted = required.length > 0 ? required : types;
  const optional = types.filter((t) => !counted.includes(t));

  const slots = ownersInScope.flatMap((o) => counted.map((t) => measureSlot(o, t, docs)));
  const optionalSlots = ownersInScope.flatMap((o) => optional.map((t) => measureSlot(o, t, docs)));
  const tally = (list, state) => list.filter((s) => s.state === state).length;

  return {
    ...stage,
    slots,
    optionalSlots,
    total: slots.length,
    verified: tally(slots, 'verified'),
    pending: tally(slots, 'pending'),
    rejected: tally(slots, 'rejected'),
    blocked: types.length === 0 ? 'unconfigured' : ownersInScope.length === 0 ? 'no-owner' : null,
    // Which upload block below the meter this stage's documents live in.
    // Multiple co-applicants each get their own; the first is the anchor.
    anchorId: ownersInScope.length > 0 ? `docList-${ownersInScope[0].key}-${stage.category}` : null,
  };
}

// ---------------------------------------------------------
// Progress meter markup
// ---------------------------------------------------------

function meterHtml(stages, openStageKey) {
  const live = stages.filter((s) => !s.blocked);
  const total = live.reduce((n, s) => n + s.total, 0);
  const verified = live.reduce((n, s) => n + s.verified, 0);
  const pending = live.reduce((n, s) => n + s.pending, 0);
  const open = stages.find((s) => s.key === openStageKey);

  const summary = total === 0
    ? 'Nothing to collect yet'
    : `${verified} of ${total} verified${pending > 0 ? ` · ${pending} awaiting review` : ''}`;

  return `
    <div class="doc-meter-head">
      <span class="doc-meter-title">File completeness</span>
      <span class="doc-meter-total">${escapeHtml(summary)}</span>
    </div>
    <div class="doc-meter-segments">${stages.map((s) => segmentHtml(s, s.key === openStageKey)).join('')}</div>
    <p class="doc-meter-hint">Solid = verified, striped = awaiting review. Pick a stage to see what's outstanding.</p>
    ${open ? stageDetailHtml(open) : ''}
  `;
}

function segmentHtml(stage, isOpen) {
  const pct = (n) => (stage.total > 0 ? (n / stage.total) * 100 : 0);
  const classes = ['doc-meter-seg'];
  if (stage.blocked) classes.push('na');
  if (isOpen) classes.push('open');
  if (!stage.blocked && stage.total > 0 && stage.verified === stage.total) classes.push('complete');

  const caption = stage.blocked === 'unconfigured' ? 'Not set up'
    : stage.blocked === 'no-owner' ? 'No co-applicant'
      : `${stage.verified} / ${stage.total}`;

  return `
    <button type="button" class="${classes.join(' ')}" data-stage="${stage.key}" aria-expanded="${isOpen}"
            aria-label="${escapeHtml(`${stage.label}: ${caption}`)}">
      <span class="doc-meter-seg-label">${escapeHtml(stage.label)}</span>
      <span class="doc-meter-bar">
        <span class="doc-meter-fill verified" style="width:${pct(stage.verified)}%;"></span>
        <span class="doc-meter-fill pending" style="width:${pct(stage.pending)}%;"></span>
        <span class="doc-meter-fill rejected" style="width:${pct(stage.rejected)}%;"></span>
      </span>
      <span class="doc-meter-count">${escapeHtml(caption)}</span>
    </button>
  `;
}

function stageDetailHtml(stage) {
  if (stage.blocked === 'unconfigured') {
    return detailShellHtml(stage, `<p class="doc-meter-note">No ${escapeHtml(stage.label)} document types exist yet, so there's nothing to collect or measure here. An admin can add them under Settings → Document Types.</p>`);
  }
  if (stage.blocked === 'no-owner') {
    return detailShellHtml(stage, '<p class="doc-meter-note">This lead has no co-applicant on it yet. Add one on the Family tab and their documents will start counting here.</p>');
  }

  const itemHtml = (slot) => `
    <div class="doc-meter-item ${slot.state}">
      <span class="st"><i class="fa-solid ${SLOT_ICON[slot.state]}"></i></span>
      <span>${escapeHtml(slot.typeName)}</span>
      ${slot.required ? '' : '<span class="opt">Optional</span>'}
      ${stage.scope === 'coapp' ? `<span class="who">${escapeHtml(slot.ownerLabel)}</span>` : ''}
      <span class="doc-meter-item-state">${escapeHtml(SLOT_TEXT[slot.state])}</span>
    </div>
  `;

  return detailShellHtml(stage, [...stage.slots, ...stage.optionalSlots].map(itemHtml).join(''));
}

function detailShellHtml(stage, bodyHtml) {
  return `
    <div class="doc-meter-detail">
      <div class="doc-meter-detail-head">
        <span class="doc-meter-detail-title">${escapeHtml(stage.label)}</span>
        ${stage.anchorId ? `<button type="button" class="btn btn-ghost doc-meter-jump" data-action="jump" data-target="${stage.anchorId}">Go to uploads</button>` : ''}
      </div>
      ${bodyHtml}
    </div>
  `;
}
