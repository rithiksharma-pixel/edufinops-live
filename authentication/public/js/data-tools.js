import { getCurrentUser } from './services/authService.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';
import {
  exportLeadsCsv, exportDealsCsv, downloadCsv, importTemplateCsv, parseLeadsCsv, commitLeadImport,
  usersBulkUpdateTemplateCsv, parseUsersBulkUpdateCsv, commitUsersBulkUpdate,
  consultanciesBulkImportTemplateCsv, parseConsultanciesCsv, commitConsultancyImport,
  lendersBulkImportTemplateCsv, parseLendersCsv, commitLenderImport,
  dealHistoryBulkImportTemplateCsv, parseDealHistoryCsv, commitDealHistoryImport,
} from './services/exportImportService.js';


let currentUser;
let pendingValidRows = [];
let pendingUsersValidRows = [];
let pendingConsultanciesValidRows = [];
let pendingLendersValidRows = [];
let pendingDealHistoryValidRows = [];

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
      const { validRows, errors, notices } = await parseLeadsCsv(file, currentUser.id);
      pendingValidRows = validRows;
      renderPreview(validRows, errors, notices);
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

  document.getElementById('btnDownloadDealHistoryTemplate').addEventListener('click', () => {
    downloadCsv(dealHistoryBulkImportTemplateCsv(), 'deal-history-import-template.csv');
  });

  document.getElementById('btnValidateDealHistoryImport').addEventListener('click', async () => {
    const fileInput = document.getElementById('dealHistoryImportFileInput');
    const file = fileInput.files[0];
    if (!file) { showToast('Choose a CSV file first.', true); return; }

    try {
      const { validRows, errors } = await parseDealHistoryCsv(file, currentUser.id);
      pendingDealHistoryValidRows = validRows;
      renderDealHistoryPreview(validRows, errors);
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

// Shared "error report" block for every importer's preview: the error
// list itself, plus Copy/Download so a long failure list (hundreds of
// rows, common on a first historical-migration attempt) doesn't have
// to be read and retyped by hand — it can go straight into a message
// to whoever owns the source spreadsheet.
function errorReportHtml(errors, idPrefix) {
  if (errors.length === 0) return '';
  return `
    <div style="display:flex;gap:8px;align-items:center;margin:10px 0 6px;">
      <button class="btn btn-ghost" id="${idPrefix}CopyErrors" style="font-size:12px;padding:5px 10px;"><i class="fa-solid fa-copy"></i> Copy errors</button>
      <button class="btn btn-ghost" id="${idPrefix}DownloadErrors" style="font-size:12px;padding:5px 10px;"><i class="fa-solid fa-download"></i> Download errors</button>
    </div>
    <ul style="color:var(--danger);font-size:13px;max-height:160px;overflow-y:auto;">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
  `;
}

function wireErrorReportButtons(idPrefix, errors, filenamePrefix) {
  document.getElementById(`${idPrefix}CopyErrors`)?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(errors.join('\n'));
      showToast('Errors copied to clipboard.');
    } catch (err) {
      showToast('Could not copy to clipboard — your browser may be blocking it.', true);
    }
  });
  document.getElementById(`${idPrefix}DownloadErrors`)?.addEventListener('click', () => {
    downloadCsv(errors.join('\n'), `${filenamePrefix}-errors-${new Date().toISOString().slice(0, 10)}.txt`);
  });
}

function notesHtml(notices) {
  if (!notices || notices.length === 0) return '';
  return `
    <p style="margin:10px 0 4px;font-size:13px;color:var(--ink-500);"><strong>${notices.length}</strong> row(s) were fuzzy-matched — review before importing:</p>
    <ul style="color:var(--ink-500);font-size:13px;max-height:120px;overflow-y:auto;">${notices.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
  `;
}

function renderPreview(validRows, errors, notices) {
  const container = document.getElementById('importPreview');
  const inserts = validRows.filter((r) => r.mode === 'insert').length;
  const updates = validRows.filter((r) => r.mode === 'update').length;
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${inserts}</strong> new, <strong>${updates}</strong> update(s) (matched by phone), <strong>${errors.length}</strong> error(s).</p>
      ${notesHtml(notices)}
      ${errorReportHtml(errors, 'leads')}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitImport" style="margin-top:12px;">Import ${inserts} new, update ${updates}</button>` : ''}
    </div>
  `;
  wireErrorReportButtons('leads', errors, 'leads-import');
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
      ${errorReportHtml(errors, 'consultancies')}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitConsultanciesImport" style="margin-top:12px;">Import ${validRows.length} consultanc${validRows.length === 1 ? 'y' : 'ies'}</button>` : ''}
    </div>
  `;
  wireErrorReportButtons('consultancies', errors, 'consultancies-import');
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
      ${errorReportHtml(errors, 'lenders')}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitLendersImport" style="margin-top:12px;">Import ${lenderCount} lender(s) &amp; ${branchCount} branch(es)</button>` : ''}
    </div>
  `;
  wireErrorReportButtons('lenders', errors, 'lenders-import');
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

function renderDealHistoryPreview(validRows, errors) {
  const container = document.getElementById('dealHistoryImportPreview');
  const inserts = validRows.filter((r) => r.mode === 'insert').length;
  const updates = validRows.filter((r) => r.mode === 'update').length;
  container.innerHTML = `
    <div class="table-card" style="padding:16px;">
      <p><strong>${inserts}</strong> new deal(s), <strong>${updates}</strong> update(s) (matched by student + lender), <strong>${errors.length}</strong> error(s).</p>
      ${errorReportHtml(errors, 'dealHistory')}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitDealHistoryImport" style="margin-top:12px;">Import ${inserts} new, update ${updates}</button>` : ''}
    </div>
  `;
  wireErrorReportButtons('dealHistory', errors, 'deal-history-import');
  const commitBtn = document.getElementById('btnCommitDealHistoryImport');
  if (commitBtn) {
    commitBtn.addEventListener('click', async () => {
      commitBtn.disabled = true;
      commitBtn.textContent = 'Importing…';
      try {
        const { succeeded, failures } = await commitDealHistoryImport(pendingDealHistoryValidRows);
        showToast(`Imported ${succeeded} deal(s)${failures.length ? `, ${failures.length} failed` : ''}.`, failures.length > 0);
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
      ${errorReportHtml(errors, 'users')}
      ${validRows.length > 0 ? `<button class="btn btn-primary" id="btnCommitUsersImport" style="margin-top:12px;">Update ${validRows.length} user(s)</button>` : ''}
    </div>
  `;
  wireErrorReportButtons('users', errors, 'users-bulk-update');
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
