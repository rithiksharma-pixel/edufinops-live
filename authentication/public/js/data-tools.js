import { getCurrentUserProfile } from './services/authService.js';
import {
  exportLeadsCsv, exportDealsCsv, downloadCsv, importTemplateCsv, parseLeadsCsv, commitLeadImport,
  usersBulkUpdateTemplateCsv, parseUsersBulkUpdateCsv, commitUsersBulkUpdate,
} from './services/exportImportService.js';

const toastEl = document.getElementById('toast');
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  setTimeout(() => (toastEl.hidden = true), 3500);
}

let currentUser;
let pendingValidRows = [];
let pendingUsersValidRows = [];

async function bootstrap() {
  try {
    currentUser = await getCurrentUserProfile();
    if (currentUser.role !== 'Admin') {
      document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-lock" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Admins only</strong><span style="color:var(--ink-500);font-size:13px;">This page is only available to Admins.</span></div>';
      return;
    }
  } catch (err) {
    document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-right-to-bracket" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Sign-in required</strong><span style="color:var(--ink-500);font-size:13px;">Please <a href="login.html" style="color:var(--accent);">sign in</a> first.</span></div>';
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

  document.getElementById('btnDownloadUsersTemplate').addEventListener('click', () => {
    downloadCsv(usersBulkUpdateTemplateCsv(), 'users-bulk-update-template.csv');
  });

  document.getElementById('btnValidateUsersImport').addEventListener('click', async () => {
    const fileInput = document.getElementById('usersImportFileInput');
    const file = fileInput.files[0];
    if (!file) { showToast('Choose a CSV file first.', true); return; }

    try {
      const { validRows, errors } = await parseUsersBulkUpdateCsv(file);
      pendingUsersValidRows = validRows;
      renderUsersPreview(validRows, errors);
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

function renderUsersPreview(validRows, errors) {
  const container = document.getElementById('usersImportPreview');
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${validRows.length}</strong> valid row(s), <strong>${errors.length}</strong> error(s).</p>
      ${errors.length > 0 ? `<ul style="color:var(--danger);font-size:13px;max-height:160px;overflow-y:auto;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitUsersImport" style="margin-top:12px;">Update ${validRows.length} user(s)</button>` : ''}
    </div>
  `;
  const commitBtn = document.getElementById('btnCommitUsersImport');
  if (commitBtn) {
    commitBtn.addEventListener('click', async () => {
      commitBtn.disabled = true;
      commitBtn.textContent = 'Updating…';
      try {
        const { succeeded, failures } = await commitUsersBulkUpdate(pendingUsersValidRows);
        showToast(`Updated ${succeeded} user(s)${failures.length ? `, ${failures.length} failed` : ''}.`, failures.length > 0);
        container.innerHTML = failures.length > 0
          ? `<p style="color:var(--danger);">${failures.length} row(s) had a problem: ${failures.map((f) => escapeHtml(`${f.email} — ${f.error}`)).join('; ')}</p>`
          : '<p>Update complete.</p>';
      } catch (err) {
        showToast('Update failed unexpectedly.', true);
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
