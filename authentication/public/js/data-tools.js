import { getCurrentUser } from './services/authService.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';
import {
  exportLeadsCsv, exportDealsCsv, downloadCsv, importTemplateCsv, parseLeadsCsv, commitLeadImport,
  usersBulkUpdateTemplateCsv, parseUsersBulkUpdateCsv, commitUsersBulkUpdate,
  consultanciesBulkImportTemplateCsv, parseConsultanciesCsv, commitConsultancyImport,
  lendersBulkImportTemplateCsv, parseLendersCsv, commitLenderImport,
} from './services/exportImportService.js';


let currentUser;
let pendingValidRows = [];
let pendingUsersValidRows = [];
let pendingConsultanciesValidRows = [];
let pendingLendersValidRows = [];

async function bootstrap() {
  try {
    currentUser = await getCurrentUser();
    if (currentUser.role !== 'Admin') {
      document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-lock" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Admins only</strong><span style="color:var(--ink-500);font-size:13px;">This page is only available to Admins.</span></div>';
      return;
    }
    mountTopbar({ app: 'user-management', user: currentUser });
    setBreadcrumb([{ label: 'User Management', href: 'users-admin.html' }, { label: 'Export / Import' }]);
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

  document.getElementById('btnDownloadConsultanciesTemplate').addEventListener('click', () => {
    downloadCsv(consultanciesBulkImportTemplateCsv(), 'consultancies-import-template.csv');
  });

  document.getElementById('btnValidateConsultanciesImport').addEventListener('click', async () => {
    const fileInput = document.getElementById('consultanciesImportFileInput');
    const file = fileInput.files[0];
    if (!file) { showToast('Choose a CSV file first.', true); return; }

    try {
      const { validRows, errors } = await parseConsultanciesCsv(file, currentUser.id);
      pendingConsultanciesValidRows = validRows;
      renderConsultanciesPreview(validRows, errors);
    } catch (err) {
      showToast('Could not parse this file. Is it a valid CSV?', true);
    }
  });

  document.getElementById('btnDownloadLendersTemplate').addEventListener('click', () => {
    downloadCsv(lendersBulkImportTemplateCsv(), 'lenders-import-template.csv');
  });

  document.getElementById('btnValidateLendersImport').addEventListener('click', async () => {
    const fileInput = document.getElementById('lendersImportFileInput');
    const file = fileInput.files[0];
    if (!file) { showToast('Choose a CSV file first.', true); return; }

    try {
      const { validRows, errors } = await parseLendersCsv(file, currentUser.id);
      pendingLendersValidRows = validRows;
      renderLendersPreview(validRows, errors);
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
  const inserts = validRows.filter((r) => r.mode === 'insert').length;
  const updates = validRows.filter((r) => r.mode === 'update').length;
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${inserts}</strong> new, <strong>${updates}</strong> update(s) (matched by phone), <strong>${errors.length}</strong> error(s).</p>
      ${errors.length > 0 ? `<ul style="color:var(--danger);font-size:13px;max-height:160px;overflow-y:auto;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitImport" style="margin-top:12px;">Import ${inserts} new, update ${updates}</button>` : ''}
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

function renderConsultanciesPreview(validRows, errors) {
  const container = document.getElementById('consultanciesImportPreview');
  const inserts = validRows.filter((r) => r.mode === 'insert').length;
  const updates = validRows.filter((r) => r.mode === 'update').length;
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${inserts}</strong> new, <strong>${updates}</strong> update(s), <strong>${errors.length}</strong> error(s).</p>
      ${errors.length > 0 ? `<ul style="color:var(--danger);font-size:13px;max-height:160px;overflow-y:auto;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitConsultanciesImport" style="margin-top:12px;">Import ${validRows.length} consultanc${validRows.length === 1 ? 'y' : 'ies'}</button>` : ''}
    </div>
  `;
  const commitBtn = document.getElementById('btnCommitConsultanciesImport');
  if (commitBtn) {
    commitBtn.addEventListener('click', async () => {
      commitBtn.disabled = true;
      commitBtn.textContent = 'Importing…';
      try {
        const { succeeded, failures } = await commitConsultancyImport(pendingConsultanciesValidRows);
        showToast(`Imported ${succeeded} consultanc${succeeded === 1 ? 'y' : 'ies'}${failures.length ? `, ${failures.length} failed` : ''}.`, failures.length > 0);
        container.innerHTML = failures.length > 0
          ? `<p style="color:var(--danger);">${failures.length} row(s) failed: ${failures.map((f) => escapeHtml(`${f.name} — ${f.error}`)).join('; ')}</p>`
          : '<p>Import complete.</p>';
      } catch (err) {
        showToast('Import failed unexpectedly.', true);
      }
    });
  }
}

function renderLendersPreview(validRows, errors) {
  const container = document.getElementById('lendersImportPreview');
  const lenderCount = validRows.filter((r) => r.type === 'lender').length;
  const branchCount = validRows.filter((r) => r.type === 'branch').length;
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${lenderCount}</strong> lender(s), <strong>${branchCount}</strong> branch(es), <strong>${errors.length}</strong> error(s).</p>
      ${errors.length > 0 ? `<ul style="color:var(--danger);font-size:13px;max-height:160px;overflow-y:auto;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitLendersImport" style="margin-top:12px;">Import ${lenderCount} lender(s) &amp; ${branchCount} branch(es)</button>` : ''}
    </div>
  `;
  const commitBtn = document.getElementById('btnCommitLendersImport');
  if (commitBtn) {
    commitBtn.addEventListener('click', async () => {
      commitBtn.disabled = true;
      commitBtn.textContent = 'Importing…';
      try {
        const { succeeded, failures } = await commitLenderImport(pendingLendersValidRows);
        showToast(`Imported ${succeeded} row(s)${failures.length ? `, ${failures.length} failed` : ''}.`, failures.length > 0);
        container.innerHTML = failures.length > 0
          ? `<p style="color:var(--danger);">${failures.length} row(s) failed: ${failures.map((f) => escapeHtml(`${f.label} — ${f.error}`)).join('; ')}</p>`
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

bootstrap();
