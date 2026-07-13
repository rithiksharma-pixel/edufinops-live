import { getCurrentUser } from './services/authService.js';
import { listMyLeads, getLeadDetail, getLeadTimeline, createMyLead } from './services/leadService.js';
import { getLeadStages, getLeadSources } from './services/lookupService.js';
import { getMessages, sendMessage } from './services/messageService.js';
import { validateLeadForm, formatCurrency, formatDateTime } from './utils/validation.js';

let currentUser;
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

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

  await renderMessages(leadId);
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

bootstrap();
