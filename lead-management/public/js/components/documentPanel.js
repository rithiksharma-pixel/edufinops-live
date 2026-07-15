// =========================================================
// PRESENTATION LAYER — Documents tab (inside the lead detail drawer)
// =========================================================
import { getDocumentTypes, getDocumentsForLead, uploadDocument, getDownloadUrl, verifyDocument, rejectDocument } from '../services/documentService.js';
import { formatDateTime } from '../utils/validation.js';

export async function initDocumentsTab(panelEl, leadId, ctx) {
  const { currentUser, showToast, coApplicants } = ctx;

  async function refresh() {
    const [docTypes, docs] = await Promise.all([getDocumentTypes(), getDocumentsForLead(leadId)]);

    const typeOptions = docTypes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}${t.is_required ? ' *' : ''}</option>`).join('');
    const coApplicantOptions = (coApplicants || []).map((c) => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('');

    panelEl.innerHTML = `
      <div class="lender-app-card">
        <div class="form-field"><label>Document type</label><select id="docTypeSelect">${typeOptions}</select></div>
        ${coApplicantOptions ? `<div class="form-field"><label>Belongs to</label><select id="docOwnerSelect"><option value="">Student</option>${coApplicantOptions}</select></div>` : ''}
        <div class="form-field"><label>File</label><input type="file" id="docFileInput" /></div>
        <button class="btn btn-primary" id="btnUploadDoc" style="width:100%;justify-content:center;">Upload</button>
      </div>
      <div id="docList" style="margin-top:14px;"></div>
    `;

    renderDocList(docs);

    document.getElementById('btnUploadDoc').addEventListener('click', async () => {
      const fileInput = document.getElementById('docFileInput');
      const file = fileInput.files[0];
      if (!file) { showToast('Choose a file first.', true); return; }
      const documentTypeId = document.getElementById('docTypeSelect').value;
      const coApplicantId = document.getElementById('docOwnerSelect')?.value || null;

      const btn = document.getElementById('btnUploadDoc');
      btn.disabled = true; btn.textContent = 'Uploading…';
      try {
        await uploadDocument({ leadId, documentTypeId, file, coApplicantId, currentUserId: currentUser.id });
        showToast('Document uploaded.');
        await refresh();
      } catch (err) {
        showToast(err.message || 'Could not upload this document.', true);
      } finally {
        btn.disabled = false; btn.textContent = 'Upload';
      }
    });
  }

  function renderDocList(docs) {
    const listEl = document.getElementById('docList');
    if (docs.length === 0) {
      listEl.innerHTML = '<div class="empty-state-block"><div class="icon"><i class="fa-solid fa-folder-open"></i></div><div class="title">No documents uploaded yet</div><p class="hint">Use the upload form above to add the student\'s first document.</p></div>';
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
