// =========================================================
// PRESENTATION LAYER — Documents tab (inside the lead detail drawer)
// One section per "owner" — the Student, then one per co-applicant on
// this lead (labeled by their relationship, e.g. "Father — Ramesh
// Sharma") — since a parent here IS a co-applicant (relationship_to_
// student = Father/Mother), not a separate entity. Within each owner,
// documents are grouped into KYC / Academics / Financials / Other
// (document_types.category); a category only renders if that owner has
// at least one document type configured for it, so an owner with no
// Academics-category types configured just doesn't show that heading.
// Each owner's upload form accepts multiple files at once, applied
// under the same document type for the whole batch.
// =========================================================
import { getDocumentTypes, getDocumentsForLead, uploadDocument, getDownloadUrl, verifyDocument, rejectDocument } from '../services/documentService.js';
import { formatDateTime } from '../utils/validation.js';
import { emptyState } from '../../../../shared/js/emptyState.js';

const CATEGORY_ORDER = ['KYC', 'Academics', 'Financials', 'Other'];

export async function initDocumentsTab(panelEl, leadId, ctx) {
  const { currentUser, showToast, coApplicants } = ctx;

  function owners() {
    return [
      { key: 'student', label: 'Student', coApplicantId: null, appliesTo: ['Student', 'Both'] },
      ...(coApplicants || []).map((c) => ({
        key: c.id,
        label: `${c.relationship_to_student} — ${c.full_name}`,
        coApplicantId: c.id,
        appliesTo: ['Co-applicant', 'Both'],
      })),
    ];
  }

  async function refresh() {
    const [docTypes, docs] = await Promise.all([getDocumentTypes(), getDocumentsForLead(leadId)]);
    panelEl.innerHTML = owners().map((owner) => renderOwnerSection(owner, docTypes)).join('');

    owners().forEach((owner) => {
      const typesForOwner = docTypes.filter((t) => owner.appliesTo.includes(t.applies_to));
      if (typesForOwner.length === 0) return; // no upload form was rendered for this owner
      wireUploadForm(owner);
      CATEGORY_ORDER.forEach((cat) => {
        if (!typesForOwner.some((t) => t.category === cat)) return;
        const docsInCat = docs.filter((d) => (d.co_applicant_id || null) === owner.coApplicantId && d.document_types?.category === cat);
        renderDocList(document.getElementById(`docList-${owner.key}-${cat}`), docsInCat);
      });
    });
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  await refresh();
}
