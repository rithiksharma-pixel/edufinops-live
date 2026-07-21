// =========================================================
// PRESENTATION LAYER — Documents tab (inside the lead detail drawer)
// Split into two sections by document_types.applies_to: Student KYC
// docs and Co-applicant docs (the latter hidden entirely if the lead
// has no co-applicants). Each section's upload form accepts multiple
// files at once — applied under the same document type + owner, since
// that covers the common case (multi-page scans, several required
// docs for one person) without needing per-file type matching.
// =========================================================
import { getDocumentTypes, getDocumentsForLead, uploadDocument, getDownloadUrl, verifyDocument, rejectDocument } from '../services/documentService.js';
import { formatDateTime } from '../utils/validation.js';
import { emptyState } from '../../../../shared/js/emptyState.js';

export async function initDocumentsTab(panelEl, leadId, ctx) {
  const { currentUser, showToast, coApplicants } = ctx;
  const hasCoApplicants = (coApplicants || []).length > 0;

  async function refresh() {
    const [docTypes, docs] = await Promise.all([getDocumentTypes(), getDocumentsForLead(leadId)]);

    const studentTypes = docTypes.filter((t) => t.applies_to === 'Student' || t.applies_to === 'Both');
    const coApplicantTypes = docTypes.filter((t) => t.applies_to === 'Co-applicant' || t.applies_to === 'Both');
    const studentDocs = docs.filter((d) => !d.co_applicants);
    const coApplicantDocs = docs.filter((d) => d.co_applicants);

    panelEl.innerHTML = `
      <div class="deal-section">
        <div class="deal-section-label">Student KYC docs</div>
        ${renderUploadForm('student', studentTypes)}
      </div>
      <div id="studentDocList" style="margin:14px 0 20px;"></div>

      ${hasCoApplicants ? `
        <div class="deal-section">
          <div class="deal-section-label">Co-applicant docs</div>
          ${renderUploadForm('coapplicant', coApplicantTypes, coApplicants)}
        </div>
        <div id="coApplicantDocList" style="margin:14px 0;"></div>
      ` : ''}
    `;

    renderDocList(document.getElementById('studentDocList'), studentDocs);
    if (hasCoApplicants) renderDocList(document.getElementById('coApplicantDocList'), coApplicantDocs);

    wireUploadForm('student', false);
    if (hasCoApplicants) wireUploadForm('coapplicant', true);
  }

  function renderUploadForm(prefix, types, coApplicantsList) {
    const typeOptions = types.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}${t.is_required ? ' *' : ''}</option>`).join('');
    const ownerField = coApplicantsList
      ? `<div class="form-field"><label>Co-applicant</label><select id="${prefix}OwnerSelect">${coApplicantsList.map((c) => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('')}</select></div>`
      : '';
    return `
      <div class="form-field"><label>Document type</label><select id="${prefix}TypeSelect">${typeOptions}</select></div>
      ${ownerField}
      <div class="form-field"><label>Files</label><input type="file" id="${prefix}FileInput" multiple /></div>
      <button class="btn btn-primary" id="${prefix}UploadBtn" style="width:100%;justify-content:center;">Upload</button>
    `;
  }

  function wireUploadForm(prefix, isCoApplicant) {
    document.getElementById(`${prefix}UploadBtn`).addEventListener('click', async () => {
      const fileInput = document.getElementById(`${prefix}FileInput`);
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) { showToast('Choose at least one file.', true); return; }
      const documentTypeId = document.getElementById(`${prefix}TypeSelect`).value;
      const coApplicantId = isCoApplicant ? document.getElementById(`${prefix}OwnerSelect`).value : null;

      const btn = document.getElementById(`${prefix}UploadBtn`);
      btn.disabled = true;
      let uploaded = 0;
      let failed = 0;
      for (const file of files) {
        btn.textContent = files.length > 1 ? `Uploading ${uploaded + failed + 1} of ${files.length}…` : 'Uploading…';
        try {
          await uploadDocument({ leadId, documentTypeId, file, coApplicantId, currentUserId: currentUser.id });
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
      listEl.innerHTML = emptyState('fa-folder-open', 'No documents uploaded yet', 'Use the upload form above to add the first document.');
      return;
    }
    listEl.innerHTML = docs.map((d) => {
      const statusBadgeClass = d.verification_status === 'Verified' ? 'badge-success' : d.verification_status === 'Rejected' ? 'badge-danger' : 'badge-warning';
      return `
        <div class="lender-app-card" data-doc-id="${d.id}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div class="lender-name">${escapeHtml(d.document_types?.name || 'Document')}${d.co_applicants ? ' · ' + escapeHtml(d.co_applicants.full_name) : ''}</div>
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
