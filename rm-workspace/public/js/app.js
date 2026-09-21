import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { guardDestination, applyNavPermissions } from '../../../shared/js/roleAccess.js';
import { getAssignedLeads, getTodaysFollowUps, getNewLeads, getDocumentsPending, getMyTatBreachedDeals } from './services/dashboardService.js';
import { getMyTasks, createTask, toggleTaskComplete, getMyOpenLeadsForTaskLink } from './services/taskService.js';
import { getLeadSources, getConsultancies, createLead } from './services/leadService.js';
import { getMyCalls, CONNECTED_DISPOSITIONS } from './services/callService.js';
import { formatCurrency, formatDateTime, formatDate, isOverdue, escapeHtml, followUpCell } from './utils/validation.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
// Cross-app import, not a duplicate — same drawer lead-management uses,
// so a lead opens in place here instead of navigating to a whole other
// app. No bundler in this repo, so a relative import across app
// boundaries is normal; the shared markup/CSS live in index.html /
// shared/css/lead-drawer.css.
import { initLeadDrawer } from '../../../lead-management/public/js/components/leadDrawer.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { mountOrgPerformance } from '../../../shared/js/orgPerformanceView.js';
import { attachDuplicatePhoneCheck } from '../../../shared/js/duplicatePhone.js';
import { supabase } from './config/supabaseClient.js';

let currentUser;
let leadDrawer;
let currentViewKey = 'dashboard';

const VIEWS = {
  assigned: { title: 'Assigned leads', subtitle: 'Every lead currently assigned to you.', load: getAssignedLeads, render: renderLeadRows },
  followups: { title: "Today's follow-ups", subtitle: 'Leads due for contact today or overdue.', load: getTodaysFollowUps, render: renderLeadRows },
  new: { title: 'New leads', subtitle: "Assigned to you, not yet actioned.", load: getNewLeads, render: renderLeadRows },
  documents: { title: 'Documents pending', subtitle: 'Uploaded documents awaiting your verification.', load: getDocumentsPending, render: renderDocumentRows },
};

/**
 * Marks a row as opening a lead. Rows are navigated via one delegated
 * listener (see initRowNavigation) rather than an inline onclick: the
 * production CSP sets `script-src 'self'` with no 'unsafe-inline', so
 * inline handlers are silently dropped by the browser — they only ever
 * appeared to work against a local server that sends no CSP header.
 * A row with no lead id gets no attribute, so it simply isn't clickable
 * instead of navigating to `?openLead=undefined`.
 */
function leadRowAttr(leadId) {
  return leadId ? ` data-lead-id="${escapeHtml(leadId)}"` : '';
}

function initRowNavigation() {
  ['listBody', 'callsListBody'].forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-lead-id]');
      if (!row || !container.contains(row)) return;
      leadDrawer.open(row.dataset.leadId);
    });
  });
}

function renderLeadRows(leads) {
  document.getElementById('listHead').innerHTML = '<tr><th>Student</th><th>Course / University</th><th>Loan amount</th><th>Stage</th><th>Next follow-up</th></tr>';
  const body = document.getElementById('listBody');
  if (leads.length === 0) {
    body.innerHTML = `<tr><td colspan="5">${emptyState('fa-inbox', 'Nothing here', 'Leads will show up here as they\'re assigned to you or as their status changes.')}</td></tr>`;
    return;
  }
  body.innerHTML = leads.map((l) => `
    <tr${leadRowAttr(l.id)}>
      <td><strong>${escapeHtml(l.student_name)}</strong><div style="font-size:12px;color:var(--ink-500);">${escapeHtml(l.student_phone)}</div></td>
      <td>${escapeHtml(l.course_name || '–')}${l.university_name ? ' · ' + escapeHtml(l.university_name) : ''}</td>
      <td>${formatCurrency(l.loan_amount_requested, l.currency)}</td>
      <td><span class="badge badge-accent">${escapeHtml(l.lead_stages?.name || '–')}</span></td>
      <td>${followUpCell(l.next_follow_up_at)}</td>
    </tr>
  `).join('');
}

function renderDocumentRows(docs) {
  document.getElementById('listHead').innerHTML = '<tr><th>Document</th><th>Student</th><th>Uploaded</th></tr>';
  const body = document.getElementById('listBody');
  if (docs.length === 0) {
    body.innerHTML = `<tr><td colspan="3">${emptyState('fa-folder-open', 'Nothing pending review', 'Documents will appear here once students upload something that needs your verification.')}</td></tr>`;
    return;
  }
  body.innerHTML = docs.map((d) => `
    <tr${leadRowAttr(d.leads?.id)}>
      <td>${escapeHtml(d.document_types?.name || 'Document')}<div style="font-size:12px;color:var(--ink-500);">${escapeHtml(d.file_name)}</div></td>
      <td>${escapeHtml(d.leads?.student_name || '–')}</td>
      <td>${formatDateTime(d.uploaded_at)}</td>
    </tr>
  `).join('');
}

const VIEW_CRUMBS = {
  dashboard: '', assigned: 'Assigned Leads', followups: "Today's Follow-ups",
  new: 'New Leads', documents: 'Documents Pending',
  calls: 'Calls', tasks: 'Tasks',
};

async function loadView(key) {
  currentViewKey = key;
  document.getElementById('dashboardView').hidden = key !== 'dashboard';
  document.getElementById('listHeader').hidden = key === 'dashboard';
  document.getElementById('listView').hidden = key === 'tasks' || key === 'dashboard' || key === 'calls';
  document.getElementById('tasksView').hidden = key !== 'tasks';
  document.getElementById('callsView').hidden = key !== 'calls';
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === key));
  setBreadcrumb(VIEW_CRUMBS[key] ? [VIEW_CRUMBS[key]] : []);

  if (key === 'dashboard') {
    try {
      await renderRmDashboard();
    } catch (err) {
      console.error(err);
      document.getElementById('rmDashAttention').innerHTML = emptyState('fa-triangle-exclamation', 'Could not load your dashboard', 'Try refreshing the page.');
    }
    return;
  }

  if (key === 'tasks') {
    document.getElementById('viewTitle').textContent = 'Tasks';
    document.getElementById('viewSubtitle').textContent = 'Your personal to-do list.';
    try {
      await refreshTasks();
    } catch (err) {
      console.error(err);
      document.getElementById('tasksList').innerHTML = emptyState('fa-triangle-exclamation', 'Could not load your tasks', 'Try refreshing the page.');
    }
    return;
  }

  if (key === 'calls') {
    document.getElementById('viewTitle').textContent = 'Calls';
    document.getElementById('viewSubtitle').textContent = 'Your call activity across every lead.';
    await renderCallsView();
    return;
  }

  const view = VIEWS[key];
  document.getElementById('viewTitle').textContent = view.title;
  document.getElementById('viewSubtitle').textContent = view.subtitle;
  document.getElementById('listBody').innerHTML = '<tr><td class="empty-state">Loading…</td></tr>';
  try {
    const data = await view.load(currentUser.id);
    view.render(data);
  } catch (err) {
    console.error(err);
    document.getElementById('listBody').innerHTML = '<tr><td class="empty-state">Could not load this view.</td></tr>';
  }
}

async function refreshTasks() {
  const tasks = await getMyTasks();
  const container = document.getElementById('tasksList');
  if (tasks.length === 0) {
    container.innerHTML = emptyState('fa-list-check', 'No tasks yet', 'Add a task above and it will show up here.');
    return;
  }
  container.innerHTML = tasks.map((t) => `
    <div class="task-item ${t.is_completed ? 'completed' : ''}">
      <input type="checkbox" class="task-checkbox" data-task-id="${t.id}" ${t.is_completed ? 'checked' : ''} />
      <div>
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="task-meta">${t.due_date ? 'Due ' + formatDate(t.due_date) : 'No due date'}${t.leads ? ' · ' + escapeHtml(t.leads.student_name) : ''}</div>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.task-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await toggleTaskComplete(cb.dataset.taskId, cb.checked);
        await refreshTasks();
      } catch (err) {
        showToast('Could not update this task.', true);
      }
    });
  });
}

let callsPeriod = 'today';

function truncate(text, max) {
  if (!text) return '–';
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

async function renderCallsView() {
  const periodLabel = callsPeriod === 'week' ? 'this week' : 'today';
  const body = document.getElementById('callsListBody');
  body.innerHTML = '<tr><td class="empty-state">Loading…</td></tr>';
  let calls;
  try {
    calls = await getMyCalls(currentUser.id, callsPeriod);
  } catch (err) {
    console.error(err);
    body.innerHTML = '<tr><td class="empty-state">Could not load your calls.</td></tr>';
    return;
  }

  const connected = calls.filter((c) => CONNECTED_DISPOSITIONS.includes(c.event_type)).length;
  const rate = calls.length ? Math.round((connected / calls.length) * 100) : 0;

  document.getElementById('callsStats').innerHTML = [
    [calls.length, `Calls ${periodLabel}`, 'fa-phone', 'var(--accent)'],
    [connected, `Connected ${periodLabel}`, 'fa-phone-volume', 'var(--success)'],
    [`${rate}%`, `Connect rate ${periodLabel}`, 'fa-chart-simple', 'var(--warning)'],
  ].map(([value, label, icon, accent]) => `<div class="stat-card" style="--stat-accent:${accent};"><div class="stat-icon"><i class="fa-solid ${icon}"></i></div><div class="amount" style="color:${accent};">${value}</div><div class="stat-label">${label}</div></div>`).join('');

  if (calls.length === 0) {
    body.innerHTML = `<tr><td colspan="4">${emptyState('fa-phone-slash', 'No calls logged yet', callsPeriod === 'week' ? "You haven't logged any calls this week." : "You haven't logged any calls today.")}</td></tr>`;
    return;
  }
  body.innerHTML = calls.map((c) => `
    <tr${leadRowAttr(c.leads?.id)}>
      <td><strong>${escapeHtml(c.leads?.student_name || '–')}</strong></td>
      <td><span class="badge ${CONNECTED_DISPOSITIONS.includes(c.event_type) ? 'badge-success' : 'badge-neutral'}">${escapeHtml(c.event_type)}</span></td>
      <td>${escapeHtml(truncate(c.remarks, 60))}</td>
      <td>${formatDateTime(c.created_at)}</td>
    </tr>
  `).join('');
}

/** The dashboard's panels are entry points, not dead ends: each one hands
 *  off to the screen that can work the whole set. */
function initDashboardLinks() {
  document.getElementById('btnOpenFollowUps').addEventListener('click', () => loadView('followups'));
  document.getElementById('btnOpenTasks').addEventListener('click', () => loadView('tasks'));
  document.getElementById('btnOpenQuiet').addEventListener('click', () => {
    const params = new URLSearchParams({ rmId: currentUser.id, notContactedDays: '30', openOnly: 'true' });
    window.location.href = `../../lead-management/public/index.html?${params}`;
  });
}

function initCallsPeriodToggle() {
  document.querySelectorAll('#callsPeriodToggle .pill-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.period === callsPeriod) return;
      callsPeriod = btn.dataset.period;
      document.querySelectorAll('#callsPeriodToggle .pill-btn').forEach((b) => b.classList.toggle('active', b === btn));
      await renderCallsView();
    });
  });
}

// =========================================================
// The dashboard is the RM's day, not a summary of what exists: what was
// promised today, what has gone quiet, and what is sitting past its
// turnaround time. Everything here is the RM's own book — every query in
// dashboardService.js filters on assigned_rm_id, because since migration 035
// RLS lets an RM READ the whole company's leads.
// =========================================================
const QUIET_DAYS = 30;
const SANCTION_ORDER = 50;
const JOURNEY_ORDER = ['Lead Qualified', 'App Start', 'Bank Prospect', 'Login', 'Sanction', 'PF Paid', 'Disbursement'];

const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dayEnd = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');

function compactInr(n) {
  if (!n) return '–';
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** Lead Lost sits at sequence_order 900 — above Disbursement — so "open"
 *  can never be inferred from stage ordering alone. */
const isLost = (l) => Boolean(l.lost_reason_id) || l.lead_stages?.name === 'Lead Lost';
const isOpenLead = (l) => !isLost(l) && (l.lead_stages?.sequence_order ?? 0) < 70;
const quietDays = (l) => daysSince(l.last_activity_at ?? l.created_at);
const isQuiet = (l) => isOpenLead(l) && quietDays(l) > QUIET_DAYS;

function greetingFor(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${(name || '').split(' ')[0] || 'there'}`;
}

function stageChipHtml(l) {
  if (isLost(l)) return '<span class="pp-chip">Lost</span>';
  const order = l.lead_stages?.sequence_order ?? 0;
  const tone = order >= SANCTION_ORDER ? 'good' : order >= 40 ? 'accent' : '';
  return `<span class="pp-chip ${tone}">${escapeHtml(l.lead_stages?.name || '–')}</span>`;
}

/** Days since last contact, as bar and figure — the same reading as the
 *  partner portals, so one explanation covers both. */
function recencyHtml(l) {
  const d = quietDays(l);
  if (d === null) return '<span class="pp-muted">–</span>';
  const tone = d > QUIET_DAYS ? 'bad' : d > 14 ? 'warn' : '';
  return `<span class="pp-meter ${tone}"><span class="pp-meter-track"><span class="pp-meter-fill" style="width:${Math.max(4, Math.min(100, (d / 60) * 100))}%"></span></span><span class="pp-meter-text">${d === 0 ? 'today' : `${d}d`}</span></span>`;
}

function promisedHtml(at) {
  if (!at) return '<span class="pp-muted">–</span>';
  const when = new Date(at);
  const late = when < dayStart();
  const label = when < dayEnd() && when >= dayStart()
    ? when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : formatDate(at);
  return `<span class="pp-num" style="color:${late ? 'var(--danger)' : 'var(--success)'}">${late ? 'Overdue · ' : ''}${label}</span>`;
}

function rowsHtml(leads, cells, emptyHtml) {
  if (leads.length === 0) return `<tr><td colspan="4">${emptyHtml}</td></tr>`;
  return leads.map((l) => `<tr data-lead-id="${escapeHtml(l.id)}">${cells(l)}</tr>`).join('');
}

async function renderRmDashboard() {
  const leads = await getAssignedLeads(currentUser.id);
  const today = new Date().toISOString().slice(0, 10);
  const [tasks, tatBreaches] = await Promise.all([getMyTasks(), getMyTatBreachedDeals(currentUser.id)]);

  const open = leads.filter(isOpenLead);
  const due = open
    .filter((l) => l.next_follow_up_at && new Date(l.next_follow_up_at) <= dayEnd())
    .sort((a, b) => new Date(a.next_follow_up_at) - new Date(b.next_follow_up_at));
  const overdue = due.filter((l) => new Date(l.next_follow_up_at) < dayStart());
  const quiet = open.filter(isQuiet).sort((a, b) => quietDays(b) - quietDays(a));
  const sanctioned = leads.filter((l) => !isLost(l) && (l.lead_stages?.sequence_order ?? 0) >= SANCTION_ORDER);
  const openTasks = tasks.filter((t) => !t.is_completed);
  const overdueTasks = openTasks.filter((t) => t.due_date && t.due_date < today);

  document.getElementById('rmGreeting').textContent = greetingFor(currentUser.fullName);
  document.getElementById('rmBlurb').textContent = due.length || quiet.length
    ? `${fmtInt(due.length)} follow-up${due.length === 1 ? '' : 's'} due today${overdue.length ? ` (${fmtInt(overdue.length)} already overdue)` : ''}, and ${fmtInt(quiet.length)} lead${quiet.length === 1 ? '' : 's'} that have gone quiet.`
    : `Nothing is due today and nothing has gone quiet across your ${fmtInt(open.length)} open leads.`;

  const stat = (label, value, sub, tone = '', view = '') => `<div class="pp-stat ${tone}"${view ? ` data-goto-view="${view}" style="cursor:pointer;"` : ''}><div class="pp-stat-label">${label}</div><div class="pp-stat-value">${value}</div>${sub ? `<div class="pp-stat-sub">${sub}</div>` : ''}</div>`;
  document.getElementById('rmDashStats').innerHTML = [
    stat('Due today', fmtInt(due.length), overdue.length ? `${fmtInt(overdue.length)} already overdue` : 'All still in hand', overdue.length ? 'bad' : '', 'followups'),
    stat(`Gone quiet ${QUIET_DAYS}+ days`, fmtInt(quiet.length), `of ${fmtInt(open.length)} open leads`, quiet.length ? 'warn' : 'good'),
    stat('Sanctioned or beyond', fmtInt(sanctioned.length), open.length ? `${((sanctioned.length / leads.length) * 100).toFixed(1)}% of your book` : '', sanctioned.length ? 'good' : ''),
    stat('Open tasks', fmtInt(openTasks.length), overdueTasks.length ? `${fmtInt(overdueTasks.length)} overdue` : 'None overdue', overdueTasks.length ? 'bad' : '', 'tasks'),
  ].join('');
  document.querySelectorAll('#rmDashStats [data-goto-view]').forEach((card) => {
    card.addEventListener('click', () => loadView(card.dataset.gotoView));
  });

  document.getElementById('rmDueBody').innerHTML = rowsHtml(
    due.slice(0, 12),
    (l) => `
      <td><div class="pp-name">${escapeHtml(l.student_name)}</div><div class="pp-sub pp-num">${escapeHtml(l.student_phone || '')}</div></td>
      <td>${stageChipHtml(l)}</td>
      <td>${recencyHtml(l)}</td>
      <td>${promisedHtml(l.next_follow_up_at)}</td>`,
    emptyState('fa-mug-hot', 'Nothing promised today', 'Follow-ups you set on a lead show up here on the day they fall due.'),
  );

  document.getElementById('rmQuietBody').innerHTML = rowsHtml(
    quiet.slice(0, 12),
    (l) => `
      <td><div class="pp-name">${escapeHtml(l.student_name)}</div><div class="pp-sub pp-num">${escapeHtml(l.student_phone || '')}</div></td>
      <td>${stageChipHtml(l)}</td>
      <td>${recencyHtml(l)}</td>
      <td class="r pp-num">${compactInr(l.loan_amount_requested)}</td>`,
    emptyState('fa-circle-check', 'Everyone has been contacted', `No open lead of yours has been untouched for ${QUIET_DAYS} days.`),
  );

  const stageCounts = {};
  open.forEach((l) => { const n = l.lead_stages?.name || 'Unknown'; stageCounts[n] = (stageCounts[n] || 0) + 1; });
  const names = [...JOURNEY_ORDER, ...Object.keys(stageCounts).filter((n) => !JOURNEY_ORDER.includes(n))].filter((n) => stageCounts[n]);
  const maxCount = Math.max(1, ...Object.values(stageCounts));
  document.getElementById('rmStageSub').textContent = `${fmtInt(open.length)} open · ${fmtInt(leads.length - open.length)} closed or lost`;
  document.getElementById('rmDashStageBreakdown').innerHTML = names.length === 0
    ? emptyState('fa-diagram-project', 'No leads assigned yet', 'Once leads are assigned to you, their stage breakdown shows here.')
    : names.map((n) => `
      <div class="pp-funnel-row">
        <span>${escapeHtml(n)}</span>
        <span class="pp-funnel-track"><span class="pp-funnel-fill" style="width:${Math.max(3, (stageCounts[n] / maxCount) * 100)}%"></span></span>
        <span class="pp-num">${fmtInt(stageCounts[n])}</span>
      </div>`).join('');

  const line = (leadId, main, sub, badge, tone) =>
    `<div class="pp-line ${leadId ? 'click' : ''}"${leadId ? ` data-lead-id="${escapeHtml(leadId)}"` : ''}>
       <span class="pp-line-main">${escapeHtml(main)}${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</span>
       <span class="pp-chip ${tone}">${escapeHtml(badge)}</span>
     </div>`;
  const attentionEl = document.getElementById('rmDashAttention');
  attentionEl.innerHTML = (overdueTasks.length + tatBreaches.length) === 0
    ? emptyState('fa-circle-check', 'Nothing overdue', 'No overdue tasks, and no case sitting past its turnaround time.')
    : overdueTasks.slice(0, 6).map((t) => line(t.leads?.id, t.title, t.leads?.student_name || '', `Task due ${formatDate(t.due_date)}`, 'bad')).join('')
      + tatBreaches.slice(0, 6).map((d) => line(d.leadId, d.student || '–', `${d.stage} stage`, `Past ${d.thresholdDays}d TAT`, 'warn')).join('');

  document.getElementById('rmTaskSub').textContent = openTasks.length
    ? `${fmtInt(openTasks.length)} open${overdueTasks.length ? ` · ${fmtInt(overdueTasks.length)} overdue` : ''}`
    : 'Nothing open';
  const tasksEl = document.getElementById('rmDashTasks');
  tasksEl.innerHTML = openTasks.length === 0
    ? emptyState('fa-list-check', 'No open tasks', 'Add one from the Tasks screen and it shows up here.')
    : openTasks.slice(0, 6).map((t) => `
      <label class="pp-task">
        <input type="checkbox" data-dash-task-id="${escapeHtml(t.id)}" />
        <span><span class="pp-task-title">${escapeHtml(t.title)}</span>
          <span class="pp-task-meta ${t.due_date && t.due_date < today ? 'late' : ''}">${t.due_date ? `Due ${formatDate(t.due_date)}` : 'No due date'}${t.leads ? ` · ${escapeHtml(t.leads.student_name)}` : ''}</span>
        </span>
      </label>`).join('');
  tasksEl.querySelectorAll('[data-dash-task-id]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await toggleTaskComplete(cb.dataset.dashTaskId, cb.checked);
        await renderRmDashboard();
      } catch (err) {
        cb.checked = !cb.checked;
        showToast('Could not update this task.', true);
      }
    });
  });

  document.querySelectorAll('#dashboardView [data-lead-id]').forEach((row) => {
    row.addEventListener('click', () => leadDrawer.open(row.dataset.leadId));
  });
}

const OTHER_CONSULTANCY_VALUE = '__other__';
let leadSources = [];

function initLeadModal() {
  const overlay = document.getElementById('leadModalOverlay');
  const form = document.getElementById('leadForm');
  const sourceSelect = document.getElementById('f_lead_source_id');
  const consultancyField = document.getElementById('consultancyField');
  const consultancySelect = document.getElementById('f_consultancy_id');
  const consultancyOtherInput = document.getElementById('f_consultancy_other_name');
  const errorEl = document.getElementById('leadFormError');

  function isBdPartnership() {
    const selected = leadSources.find((s) => s.id === sourceSelect.value);
    return selected?.name === 'BD Partnership';
  }

  function toggleConsultancyField() {
    const show = isBdPartnership();
    consultancyField.hidden = !show;
    if (!show) {
      consultancySelect.value = '';
      consultancyOtherInput.hidden = true;
      consultancyOtherInput.value = '';
    }
  }
  sourceSelect.addEventListener('change', toggleConsultancyField);
  consultancySelect.addEventListener('change', () => {
    const isOther = consultancySelect.value === OTHER_CONSULTANCY_VALUE;
    consultancyOtherInput.hidden = !isOther;
    if (!isOther) consultancyOtherInput.value = '';
  });

  async function open() {
    errorEl.textContent = '';
    form.reset();
    dupCheck.reset();
    if (sourceSelect.options.length <= 0) {
      leadSources = await getLeadSources();
      sourceSelect.innerHTML = leadSources.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    }
    if (consultancySelect.options.length <= 0) {
      const consultancies = await getConsultancies();
      consultancySelect.innerHTML =
        `<option value="">Select consultancy…</option>` +
        consultancies.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') +
        `<option value="${OTHER_CONSULTANCY_VALUE}">Other</option>`;
    }
    toggleConsultancyField();
    overlay.hidden = false;
  }
  function close() { overlay.hidden = true; }
  window.__closeLeadModal = close;

  // Warns, before saving, when this number is already on another lead;
  // "Open" swaps the form for that lead's drawer.
  const dupCheck = attachDuplicatePhoneCheck({
    input: document.getElementById('f_rm_student_phone'),
    supabase,
    onOpen: (leadId) => { close(); leadDrawer.open(leadId); },
  });

  document.getElementById('btnNewLead').addEventListener('click', open);
  document.getElementById('btnNewLeadList').addEventListener('click', open);
  document.getElementById('btnCloseLeadModal').addEventListener('click', close);
  document.getElementById('btnCancelLeadModal').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    if (!payload.student_name?.trim() || !payload.student_phone?.trim()) {
      errorEl.textContent = 'Student name and phone are required.';
      return;
    }
    const amount = Number(payload.loan_amount_requested);
    if (!payload.loan_amount_requested || Number.isNaN(amount) || amount <= 0) {
      errorEl.textContent = 'Enter a loan amount greater than zero.';
      return;
    }
    if (!payload.lead_source_id) {
      errorEl.textContent = 'Select where this lead came from.';
      return;
    }

    let consultancyId = null;
    let consultancyOtherName = null;
    if (isBdPartnership()) {
      if (!consultancySelect.value) { errorEl.textContent = 'Choose the consultancy this lead came from.'; return; }
      if (consultancySelect.value === OTHER_CONSULTANCY_VALUE) {
        consultancyOtherName = consultancyOtherInput.value.trim();
        if (!consultancyOtherName) { errorEl.textContent = 'Enter the consultancy name.'; return; }
      } else {
        consultancyId = consultancySelect.value;
      }
    }

    const submitBtn = document.getElementById('btnSubmitLead');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
      await createLead({
        student_name: payload.student_name.trim(),
        student_phone: payload.student_phone.trim(),
        student_email: payload.student_email?.trim() || null,
        course_name: payload.course_name?.trim() || null,
        university_name: payload.university_name?.trim() || null,
        destination_country: payload.destination_country?.trim() || null,
        loan_amount_requested: amount,
        lead_source_id: payload.lead_source_id,
        consultancy_id: consultancyId,
        consultancy_other_name: consultancyOtherName,
        source_user_id: currentUser.id,
      }, currentUser.id);
      showToast('Lead saved.');
      close();
      if (document.getElementById('dashboardView').hidden === false) await renderRmDashboard();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save this lead. Please try again.', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save lead';
    }
  });
}

async function bootstrap() {
  try {
    currentUser = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-right-to-bracket" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Sign-in required</strong><span style="color:var(--ink-500);font-size:13px;">Please <a href="../../authentication/public/login.html" style="color:var(--accent);">sign in</a> first.</span></div>';
    return;
  }
  document.getElementById('userName').textContent = currentUser.fullName;
  document.getElementById('avatar').textContent = currentUser.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  // Send anyone whose role has no business on this screen to their own
  // home. RLS still decides what data they could read; this decides
  // which surface they are looking at.
  if (!guardDestination(currentUser, 'rm-workspace')) return;
  applyNavPermissions(currentUser.role);
  mountTopbar({ app: 'rm-workspace', user: currentUser });

  leadDrawer = initLeadDrawer({
    showToast,
    onLeadUpdated: () => loadView(currentViewKey),
    currentUser,
  });

  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); loadView(el.dataset.view); });
  });
  initLeadModal();
  initCallsPeriodToggle();
  initDashboardLinks();
  mountOrgPerformance({ host: document.getElementById('rmSourcePerf'), supabase, scope: 'rm', userId: currentUser.id });
  initRowNavigation();

  try {
    const leadOptions = await getMyOpenLeadsForTaskLink(currentUser.id);
    document.getElementById('taskLeadSelect').insertAdjacentHTML('beforeend', leadOptions.map((l) => `<option value="${l.id}">${escapeHtml(l.student_name)}</option>`).join(''));
  } catch (err) {
    console.error(err);
  }

  document.getElementById('btnAddTask').addEventListener('click', async () => {
    const title = document.getElementById('taskTitle').value.trim();
    if (!title) { showToast('Enter a task title.', true); return; }
    try {
      await createTask({
        title,
        dueDate: document.getElementById('taskDueDate').value || null,
        leadId: document.getElementById('taskLeadSelect').value || null,
      }, currentUser.id);
      document.getElementById('taskTitle').value = '';
      document.getElementById('taskDueDate').value = '';
      showToast('Task added.');
      await refreshTasks();
    } catch (err) {
      showToast('Could not add this task.', true);
    }
  });

  await loadView('dashboard');
}

guardBootstrap(bootstrap, 'RM Workspace');