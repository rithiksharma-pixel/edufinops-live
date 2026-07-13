import { getCurrentUserProfile } from './services/authService.js';
import { exportLeadsCsv, exportDealsCsv, downloadCsv, importTemplateCsv, parseLeadsCsv, commitLeadImport } from './services/exportImportService.js';

const toastEl = document.getElementById('toast');
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  setTimeout(() => (toastEl.hidden = true), 3500);
}

let currentUser;
let pendingValidRows = [];

async function bootstrap() {
  try {
    currentUser = await getCurrentUserProfile();
    if (currentUser.role !== 'Admin') {
      document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">This page is only available to Admins.</div>';
      return;
    }
  } catch (err) {
    document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">Please <a href="login.html">sign in</a> first.</div>';
    return;
  }

  document.getElementById('btnExportLeads').addEventListener('click', async () => {
    try {
      const csv = await exportLeadsCsv();
      downloadCsv(csv, `leads-export-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      showToast('Could not export leads.', true);
    }
  });

  document.getElementById('btnExportDeals').addEventListener('click', async () => {
    try {
      const csv = await exportDealsCsv();
      downloadCsv(csv, `deals-export-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      showToast('Could not export deals.', true);
    }
  });

  document.getElementById('btnDownloadTemplate').addEventListener('click', () => {
    downloadCsv(importTemplateCsv(), 'leads-import-template.csv');
  });

  document.getElementById('btnValidateImport').addEventListener('click', async () => {
    const fileInput = document.getElementById('importFileInput');
    const file = fileInput.files[0];
    if (!file) { showToast('Choose a CSV file first.', true); return; }

    try {
      const { validRows, errors } = await parseLeadsCsv(file, currentUser.id);
      pendingValidRows = validRows;
      renderPreview(validRows, errors);
    } catch (err) {
      showToast('Could not parse this file. Is it a valid CSV?', true);
    }
  });
}

function renderPreview(validRows, errors) {
  const container = document.getElementById('importPreview');
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${validRows.length}</strong> valid row(s), <strong>${errors.length}</strong> error(s).</p>
      ${errors.length > 0 ? `<ul style="color:var(--danger);font-size:13px;max-height:160px;overflow-y:auto;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitImport" style="margin-top:12px;">Import ${validRows.length} lead(s)</button>` : ''}
    </div>
  `;
  const commitBtn = document.getElementById('btnCommitImport');
  if (commitBtn) {
    commitBtn.addEventListener('click', async () => {
      commitBtn.disabled = true;
      commitBtn.textContent = 'Importing…';
      try {
        const { succeeded, failures } = await commitLeadImport(pendingValidRows);
        showToast(`Imported ${succeeded} lead(s)${failures.length ? `, ${failures.length} failed` : ''}.`, failures.length > 0);
        container.innerHTML = failures.length > 0
          ? `<p style="color:var(--danger);">${failures.length} row(s) failed during import: ${failures.map((f) => escapeHtml(f.error)).join('; ')}</p>`
          : '<p>Import complete.</p>';
      } catch (err) {
        showToast('Import failed unexpectedly.', true);
      }
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

bootstrap();
