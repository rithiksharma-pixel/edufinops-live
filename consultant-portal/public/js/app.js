import { getCurrentUser } from './services/authService.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { listMyLeads, getLeadDetail, getLeadTimeline, createMyLead } from './services/leadService.js';
import { getLeadStages, getLeadSources } from './services/lookupService.js';
import { getMessages, sendMessage } from './services/messageService.js';
import { validateLeadForm, formatCurrency, formatDateTime } from './utils/validation.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import { getLenderProgress } from './services/reportService.js';
import { getDocumentTypes, getDocumentsForLead, uploadDocument, getDownloadUrl } from './services/documentService.js';

let currentUser;

const formatDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '–');

async function refreshLeads(search) {
  const tbody = document.getElementById('leadsBody');
  const leads = await listMyLeads(search);
  renderCpDashStats(leads);
  if (leads.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No students submitted yet.</td></tr>';
    return;
  }
  tbody.innerHTML = leads.map((l) => `
    <tr data-id="${l.id}">
      <td><strong>${escapeHtml(l.student_name)}</strong><div style="font-size:12px;color:var(--ink-500);">${escapeHtml(l.student_phone)}</div></td>
      <td>${escapeHtml(l.course_name || '–')}${l.university_name ? ' · ' + escapeHtml(l.university_name) : ''}</td>
      <td>${formatCurrency(l.loan_amount_requested, l.currency)}</td>
      <td><span class="badge badge-accent">${escapeHtml(l.lead_stages?.name || '–')}</span></td>
      <td>${formatDateTime(l.created_at)}</td>
    </tr>
  `).join('');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.id));
  });
}

function renderCpDashStats(leads) {
  const disbursed = leads.filter((l) => l.lead_stages?.name === 'Disbursed').length;
  const inProgress = leads.length - disbursed;
  document.getElementById('cpDashStats').innerHTML = `
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px 16px;"><div class="amount" style="font-size:22px;font-weight:600;">${leads.length}</div><div style="font-size:12px;color:var(--ink-500);margin-top:3px;">Total submitted</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px 16px;"><div class="amount" style="font-size:22px;font-weight:600;">${inProgress}</div><div style="font-size:12px;color:var(--ink-500);margin-top:3px;">In progress</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px 16px;"><div class="amount" style="font-size:22px;font-weight:600;color:var(--success);">${disbursed}</div><div style="font-size:12px;color:var(--ink-500);margin-top:3px;">Disbursed</div></div>
  `;
}

async function openDrawer(leadId) {
  document.getElementById('drawerOverlay').hidden = false;
  const [lead, timeline] = await Promise.all([getLeadDetail(leadId), getLeadTimeline(leadId)]);
  document.getElementById('drawerName').textContent = lead.student_name;
  document.getElementById('drawerSubtitle').textContent = [lead.course_name, lead.university_name].filter(Boolean).join(' · ') || 'No course details yet';

  document.getElementById('panelStatus').innerHTML = timeline.map((ev) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div><div class="timeline-event">${escapeHtml(ev.event_type)}</div><div class="timeline-meta">${formatDateTime(ev.created_at)}${ev.to_stage ? ' · ' + escapeHtml(ev.to_stage.name) : ''}</div></div>
    </div>
  `).join('') || '<p class="empty-state">No activity yet.</p>';

  await Promise.all([renderLenderProgress(leadId), renderDocuments(leadId), renderMessages(leadId)]);
}

/**
 * Which banks this student went to and where each stands.
 *
 * A Consultant gets zero rows from `deals` and cannot read `lenders` at
 * all, so this comes from the get_lead_lender_progress RPC, which is
 * authorised by can_view_lead() and returns stage information only — no
 * sanction amounts, rates or internal remarks.
 */
async function renderLenderProgress(leadId) {
  const panel = document.getElementById('panelLenders');
  try {
    const banks = await getLenderProgress(leadId);
    if (!banks.length) {
      panel.innerHTML = emptyState('fa-building-columns', 'Not with a bank yet', 'Once our team shares this student with a lender, their progress shows up here.');
      return;
    }
    panel.innerHTML = banks.map((b) => {
      let badge = `<span class="badge badge-accent">${escapeHtml(b.deal_stage || '–')}</span>`;
      if (b.is_rejected) badge = '<span class="badge badge-danger">Rejected</span>';
      else if (b.is_on_hold) badge = '<span class="badge badge-warning">On hold</span>';
      const dates = [
        b.login_date && `Logged in ${formatDate(b.login_date)}`,
        b.sanction_date && `Sanctioned ${formatDate(b.sanction_date)}`,
        b.pf_date && `PF paid ${formatDate(b.pf_date)}`,
      ].filter(Boolean).join(' · ');
      return `<div class="message-bubble" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <strong>${escapeHtml(b.lender_name || 'Bank')}</strong>${badge}
        </div>
        ${b.branch_name ? `<div class="message-meta">${escapeHtml(b.branch_name)}</div>` : ''}
        ${dates ? `<div class="message-meta">${escapeHtml(dates)}</div>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    console.error('lender progress failed', err);
    panel.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load bank progress', 'Try reopening this student.');
  }
}

async function renderDocuments(leadId) {
  const panel = document.getElementById('panelDocuments');
  try {
    const [types, docs] = await Promise.all([getDocumentTypes(), getDocumentsForLead(leadId)]);
    const typeOptions = types.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');

    // data-index rather than data-download="<storage_path>": the path
    // contains the uploaded file name, and escapeHtml() does not escape
    // quotes — a student sending "my passport".pdf would break out of the
    // attribute. The index is looked up against `docs` on click instead.
    const list = docs.length
      ? docs.map((d, i) => `<div class="message-bubble" style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <div>
              <strong>${escapeHtml(d.document_types?.name || 'Document')}</strong>
              <div class="message-meta">${escapeHtml(d.file_name)} · ${formatDateTime(d.uploaded_at)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;white-space:nowrap;">
              <span class="badge ${d.verification_status === 'Verified' ? 'badge-accent' : d.verification_status === 'Rejected' ? 'badge-danger' : 'badge-warning'}">${escapeHtml(d.verification_status)}</span>
              <button class="btn btn-ghost" data-doc-index="${i}">Open</button>
            </div>
          </div>
        </div>`).join('')
      : '<p class="empty-state">Nothing uploaded yet.</p>';

    panel.innerHTML = `${list}
      <div class="message-compose" style="flex-wrap:wrap;gap:8px;">
        <select id="cpDocType" style="flex:1 1 160px;padding:9px 11px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit;">${typeOptions}</select>
        <input type="file" id="cpDocFile" style="flex:1 1 180px;font-size:12px;" />
        <button class="btn btn-primary" id="cpDocUpload">Upload</button>
      </div>`;

    panel.querySelectorAll('[data-doc-index]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          window.open(await getDownloadUrl(docs[Number(btn.dataset.docIndex)].storage_path), '_blank');
        } catch (err) {
          showToast('Could not open that file.', true);
        }
      });
    });

    const uploadBtn = document.getElementById('cpDocUpload');
    uploadBtn.addEventListener('click', async () => {
      const file = document.getElementById('cpDocFile').files?.[0];
      if (!file) { showToast('Choose a file first.', true); return; }
      const typeId = document.getElementById('cpDocType').value;
      // Captured in a local, not read off the event: `currentTarget` is
      // nulled once the dispatch returns, and this handler awaits.
      uploadBtn.disabled = true;
      try {
        await uploadDocument({ leadId, documentTypeId: typeId, file });
        showToast('Uploaded.');
        await renderDocuments(leadId); // replaces this button along with the panel
      } catch (err) {
        console.error('consultant upload failed', err);
        showToast(err.message || 'Could not upload that file.', true);
        uploadBtn.disabled = false; // only re-enable if the panel was NOT re-rendered
      }
    });
  } catch (err) {
    console.error('documents failed', err);
    panel.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load documents', 'Try reopening this student.');
  }
}

async function renderMessages(leadId) {
  const panel = document.getElementById('panelMessages');
  const messages = await getMessages(leadId);
  panel.innerHTML =
    (messages.length === 0 ? '<p class="empty-state">No messages yet.</p>' :
      messages.map((m) => `<div class="message-bubble"><div class="message-meta">${escapeHtml(m.sender?.full_name || 'Someone')} · ${formatDateTime(m.created_at)}</div>${escapeHtml(m.message)}</div>`).join('')) +
    '<div class="message-compose"><textarea id="messageInput" rows="2" placeholder="Ask about this student…"></textarea><button class="btn btn-primary" id="btnSendMessage">Send</button></div>';

  document.getElementById('btnSendMessage').addEventListener('click', async () => {
    const text = document.getElementById('messageInput').value.trim();
    if (!text) return;
    try {
      await sendMessage(leadId, currentUser.id, text);
      await renderMessages(leadId);
    } catch (err) {
      showToast('Could not send message.', true);
    }
  });
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });
}

function initDrawerClose() {
  const overlay = document.getElementById('drawerOverlay');
  document.getElementById('btnCloseDrawer').addEventListener('click', () => (overlay.hidden = true));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
}

function initAddLeadModal(stages, sources) {
  const overlay = document.getElementById('addLeadOverlay');
  const form = document.getElementById('addLeadForm');
  document.getElementById('sourceSelect').innerHTML = sources.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const openingStage = stages.find((s) => s.sequence_order === Math.min(...stages.map((x) => x.sequence_order)));

  document.getElementById('btnAddLead').addEventListener('click', () => { form.reset(); overlay.hidden = false; });
  document.getElementById('btnCloseAdd').addEventListener('click', () => (overlay.hidden = true));
  document.getElementById('btnCancelAdd').addEventListener('click', () => (overlay.hidden = true));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    const { valid, errors } = validateLeadForm(payload);
    form.querySelectorAll('.field-error').forEach((el) => (el.textContent = ''));
    if (!valid) {
      Object.entries(errors).forEach(([field, msg]) => {
        const el = form.querySelector(`[data-error-for="${field}"]`);
        if (el) el.textContent = msg;
      });
      return;
    }
    try {
      await createMyLead({
        student_name: payload.student_name.trim(),
        student_phone: payload.student_phone.trim(),
        student_email: payload.student_email?.trim() || null,
        course_name: payload.course_name?.trim() || null,
        university_name: payload.university_name?.trim() || null,
        destination_country: payload.destination_country?.trim() || null,
        loan_amount_requested: Number(payload.loan_amount_requested),
        lead_source_id: payload.lead_source_id,
      }, currentUser.id, openingStage.id);
      showToast('Student added.');
      overlay.hidden = true;
      await refreshLeads();
    } catch (err) {
      showToast(err.message || 'Could not save this lead.', true);
    }
  });
}

async function bootstrap() {
  try {
    currentUser = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">Please sign in first.</div>';
    return;
  }
  document.getElementById('userName').textContent = currentUser.fullName;
  document.getElementById('avatar').textContent = currentUser.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  mountTopbar({ app: 'consultant-portal', user: currentUser });

  const [stages, sources] = await Promise.all([getLeadStages(), getLeadSources()]);
  initTabs();
  initDrawerClose();
  initAddLeadModal(stages, sources);

  let debounce;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => refreshLeads(e.target.value.trim()), 250);
  });

  await refreshLeads();
}

guardBootstrap(bootstrap, 'Consultant Portal');