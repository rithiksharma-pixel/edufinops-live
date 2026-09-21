import { getCurrentUser } from './services/authService.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { guardDestination, applyNavPermissions } from '../../../shared/js/roleAccess.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import { listMyStudents, getPortalContext, getStudentTimeline, createMyLead } from './services/leadService.js';
import { getLeadStages, getLeadSources } from './services/lookupService.js';
import { getMessages, sendMessage } from './services/messageService.js';
import { validateLeadForm, formatDateTime } from './utils/validation.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { leadFunnel, leadFunnelRowsHtml } from '../../../shared/js/leadFunnel.js';

let currentUser;

// The path a student walks, in order. Lead Lost is not on it: it sits at
// sequence 900 and is an exit, never a step past Disbursement.
const JOURNEY = ['Lead Qualified', 'App Start', 'Bank Prospect', 'Login', 'Sanction', 'PF Paid', 'Disbursement'];
const LOGIN_ORDER = 40;
const SANCTION_ORDER = 50;
const DISBURSED_ORDER = 70;
const QUIET_DAYS = 30;
const PAGE = 100;

const state = { rows: [], tab: 'all', search: '', shown: PAGE };

const daysSince = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
const isOpen = (r) => !r.is_lost && (r.stage_order ?? 0) < DISBURSED_ORDER;
const isQuiet = (r) => isOpen(r) && daysSince(r.last_activity_at) > QUIET_DAYS;
const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');
const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '–');

const TABS = [
  { id: 'all', label: 'All', test: () => true, hint: 'Every student referred, newest first.' },
  { id: 'open', label: 'In progress', test: isOpen, hint: 'Still moving towards a loan. Newest first.' },
  { id: 'sanctioned', label: 'Sanctioned', test: (r) => !r.is_lost && r.stage_order >= SANCTION_ORDER,
    hint: 'Sanctioned, fee paid or disbursed.' },
  { id: 'quiet', label: `No update ${QUIET_DAYS}+ days`, alert: true, test: isQuiet,
    hint: 'Open students with nothing recorded for over a month. Worth a message to the team.' },
  { id: 'lost', label: 'Closed', test: (r) => r.is_lost, hint: 'Students who did not go ahead.' },
];

const currentTab = () => TABS.find((t) => t.id === state.tab) || TABS[0];

function visibleRows() {
  const q = state.search.toLowerCase();
  const digits = q.replace(/\D/g, '');
  const rows = state.rows
    .filter(currentTab().test)
    .filter((r) => !q
      || (r.student_name || '').toLowerCase().includes(q)
      || (digits && (r.student_phone || '').replace(/\D/g, '').includes(digits)));
  return state.tab === 'quiet'
    ? rows.sort((a, b) => new Date(a.last_activity_at) - new Date(b.last_activity_at))
    : rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function stageChip(r) {
  if (r.is_lost) return '<span class="pp-chip bad">Did not proceed</span>';
  const tone = r.stage_order >= SANCTION_ORDER ? 'good' : r.stage_order >= LOGIN_ORDER ? 'accent' : '';
  return `<span class="pp-chip ${tone}">${escapeHtml(r.stage_name || '–')}</span>`;
}

function recency(r) {
  const d = daysSince(r.last_activity_at);
  if (!isOpen(r)) return `<span class="pp-num">${shortDate(r.last_activity_at)}</span>`;
  const tone = d > QUIET_DAYS ? 'bad' : d > 14 ? 'warn' : '';
  return `<span class="pp-meter ${tone}" title="Last recorded ${shortDate(r.last_activity_at)}">
    <span class="pp-meter-track"><span class="pp-meter-fill" style="width:${Math.max(4, Math.min(100, (d / 60) * 100))}%"></span></span>
    <span class="pp-meter-text">${d === 0 ? 'today' : `${d}d ago`}</span></span>`;
}

function renderStats() {
  const rows = state.rows;
  const total = rows.length;
  const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}% of referred` : '');
  const login = rows.filter((r) => !r.is_lost && r.stage_order >= LOGIN_ORDER).length;
  const sanctioned = rows.filter((r) => !r.is_lost && r.stage_order >= SANCTION_ORDER).length;
  const quiet = rows.filter(isQuiet).length;
  const mine = rows.filter((r) => r.submitted_by_me).length;

  const stat = (label, value, sub, tone = '') => `<div class="pp-stat ${tone}"><div class="pp-stat-label">${label}</div><div class="pp-stat-value">${value}</div>${sub ? `<div class="pp-stat-sub">${sub}</div>` : ''}</div>`;
  document.getElementById('cpDashStats').innerHTML = [
    stat('Students referred', fmtInt(total), mine && mine !== total ? `${fmtInt(mine)} added by you` : ''),
    stat('Reached bank login', fmtInt(login), pct(login)),
    stat('Sanctioned', fmtInt(sanctioned), pct(sanctioned), sanctioned ? 'good' : ''),
    stat(`No update ${QUIET_DAYS}+ days`, fmtInt(quiet), quiet ? 'Still open, nothing recorded' : 'Everyone is moving', quiet ? 'warn' : 'good'),
  ].join('');
}

function renderFunnel() {
  // Reached, not current: a student counts at every stage they got to, so
  // each step's rate shows where the firm's students drop out.
  const lost = state.rows.filter((r) => r.is_lost).length;
  document.getElementById('cpFunnel').innerHTML = state.rows.length === 0
    ? emptyState('fa-user-graduate', 'No students yet', 'Add your first student to start tracking their loan.')
    : leadFunnelRowsHtml(leadFunnel(state.rows), escapeHtml) +
      `<div class="pp-funnel-row" style="margin-top:6px;color:var(--ink-500);"><span>Did not proceed</span><span></span><span class="pp-num">${fmtInt(lost)}</span></div>`;
}

function renderTabs() {
  const el = document.getElementById('cpTabs');
  el.innerHTML = TABS.map((t) => {
    const n = state.rows.filter(t.test).length;
    return `<button class="pp-tab ${t.id === state.tab ? 'on' : ''} ${t.alert && n ? 'alert' : ''}" role="tab" aria-selected="${t.id === state.tab}" data-tab-id="${t.id}">${escapeHtml(t.label)} <span class="n">${fmtInt(n)}</span></button>`;
  }).join('');
  el.querySelectorAll('[data-tab-id]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tabId; state.shown = PAGE; renderTabs(); renderRows();
  }));
  document.getElementById('cpHint').textContent = currentTab().hint;
}

function renderRows() {
  const tbody = document.getElementById('leadsBody');
  const more = document.getElementById('cpMore');
  const rows = visibleRows();
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">${state.rows.length === 0
      ? emptyState('fa-user-graduate', 'No students submitted yet', 'Use "Add student" to refer your first one.')
      : emptyState('fa-magnifying-glass', 'No matches', state.search ? 'Try a different name or phone number.' : 'No students in this view right now.')}</td></tr>`;
    more.hidden = true;
    return;
  }
  tbody.innerHTML = rows.slice(0, state.shown).map((r) => `
    <tr data-id="${r.lead_id}">
      <td><div class="pp-name">${escapeHtml(r.student_name)}</div><div class="pp-sub pp-num">${escapeHtml(r.student_phone || '')}</div></td>
      <td><div>${escapeHtml(r.course_name || '–')}</div><div class="pp-sub">${escapeHtml([r.university_name, r.destination_country].filter(Boolean).join(' · '))}</div></td>
      <td>${stageChip(r)}</td>
      <td class="pp-num">${shortDate(r.created_at)}</td>
      <td>${recency(r)}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDrawer(tr.dataset.id)));

  more.hidden = false;
  more.innerHTML = rows.length > state.shown
    ? `<span>Showing ${fmtInt(state.shown)} of ${fmtInt(rows.length)}</span><button class="btn btn-ghost" id="btnShowMore">Show more</button>`
    : `<span>${fmtInt(rows.length)} student${rows.length === 1 ? '' : 's'}</span><span></span>`;
  document.getElementById('btnShowMore')?.addEventListener('click', () => { state.shown += PAGE; renderRows(); });
}

async function refreshLeads() {
  state.rows = await listMyStudents();
  renderStats();
  renderFunnel();
  renderTabs();
  renderRows();
}

async function openDrawer(leadId) {
  const row = state.rows.find((r) => r.lead_id === leadId);
  if (!row) return;
  document.getElementById('drawerOverlay').hidden = false;
  document.getElementById('drawerName').textContent = row.student_name;
  document.getElementById('drawerSubtitle').textContent =
    [row.course_name, row.university_name].filter(Boolean).join(' · ') || 'No course details yet';

  const panel = document.getElementById('panelStatus');
  panel.innerHTML = '<div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>';
  document.getElementById('panelMessages').innerHTML = '';

  let timeline = [];
  try {
    timeline = await getStudentTimeline(leadId);
  } catch (err) {
    panel.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load progress', 'Close and reopen this student.');
    return;
  }

  // First date each stage was reached. The timeline is newest-first, so the
  // last write per stage wins as the earliest.
  const reached = {};
  timeline.forEach((e) => { if (e.stage_name) reached[e.stage_name] = e.created_at; });
  const currentIdx = JOURNEY.indexOf(row.stage_name);
  const lostAt = timeline.find((e) => e.event_type === 'Lead Lost' || e.stage_name === 'Lead Lost');

  const note = row.is_lost
    ? `<div class="pp-note bad">This student did not go ahead${lostAt ? ` (closed ${shortDate(lostAt.created_at)})` : ''}. Message the team if you think that is wrong.</div>`
    : isQuiet(row)
      ? `<div class="pp-note">Nothing recorded for ${daysSince(row.last_activity_at)} days. Use Messages to ask the team for an update.</div>`
      : '';

  panel.innerHTML = note + `<ol class="pp-steps">${JOURNEY.map((name, i) => {
    const done = currentIdx >= 0 ? i <= currentIdx : Boolean(reached[name]);
    const date = reached[name] || (i === 0 && done ? row.created_at : null);
    return `<li class="pp-step ${done ? 'done' : ''}">
      <span class="pp-step-dot"></span>
      <span><span class="pp-step-label">${escapeHtml(name)}</span><br><span class="pp-step-date">${done ? (date ? shortDate(date) : 'reached') : 'not yet'}</span></span>
    </li>`;
  }).join('')}</ol>
  <p class="pp-sub">Referred ${shortDate(row.created_at)} · last update ${shortDate(row.last_activity_at)}</p>`;

  await renderMessages(leadId);
}

async function renderMessages(leadId) {
  const panel = document.getElementById('panelMessages');
  let messages = [];
  try {
    messages = await getMessages(leadId);
  } catch (err) {
    panel.innerHTML = '<p class="empty-state">Could not load messages.</p>';
    return;
  }
  panel.innerHTML =
    (messages.length === 0 ? '<p class="empty-state">No messages yet. Ask the team anything about this student.</p>' :
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
      state.tab = 'all';
      await refreshLeads();
    } catch (err) {
      showToast(err.message || 'Could not save this student.', true);
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
  // Send anyone whose role has no business on this screen to their own
  // home. RLS still decides what data they could read; this decides
  // which surface they are looking at.
  if (!guardDestination(currentUser, 'consultant-portal')) return;
  applyNavPermissions(currentUser.role);
  mountTopbar({ app: 'consultant-portal', user: currentUser });

  const [stages, sources, context] = await Promise.all([getLeadStages(), getLeadSources(), getPortalContext()]);
  if (context.consultancy_name) {
    document.getElementById('cpTitle').textContent = context.consultancy_name;
    document.getElementById('cpBlurb').textContent =
      `Every student ${context.consultancy_name} has referred, and where each one has reached. Loan terms and lender details stay with the Zolve team.`;
  } else {
    document.getElementById('cpBlurb').textContent =
      'Students you have added, and where each one has reached. Ask your Zolve contact to link this login to your firm to see all of its students.';
  }

  initTabs();
  initDrawerClose();
  initAddLeadModal(stages, sources);

  let debounce;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.search = e.target.value.trim(); state.shown = PAGE; renderRows(); }, 150);
  });

  await refreshLeads();
}

guardBootstrap(bootstrap, 'Consultant Portal');
