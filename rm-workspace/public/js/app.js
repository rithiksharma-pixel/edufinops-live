import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { getAssignedLeads, getTodaysFollowUps, getNewLeads, getDocumentsPending, getLenderUpdates, getMyTatBreachedDeals } from './services/dashboardService.js';
import { getMyTasks, createTask, toggleTaskComplete, getMyOpenLeadsForTaskLink } from './services/taskService.js';
import { getLeadSources, getConsultancies, createLead } from './services/leadService.js';
import { getMyCalls } from './services/callService.js';
import { formatCurrency, formatDateTime, formatDate, isOverdue, escapeHtml } from './utils/validation.js';

let currentUser;
const toastEl = document.getElementById('toast');
const emptyState = (icon, title, hint) => `<div class="empty-state-block"><div class="icon"><i class="fa-solid ${icon}"></i></div><div class="title">${escapeHtml(title)}</div><p class="hint">${escapeHtml(hint)}</p></div>`;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  setTimeout(() => (toastEl.hidden = true), 3000);
}

const VIEWS = {
  assigned: { title: 'Assigned leads', subtitle: 'Every lead currently assigned to you.', load: getAssignedLeads, render: renderLeadRows },
  followups: { title: "Today's follow-ups", subtitle: 'Leads due for contact today or overdue.', load: getTodaysFollowUps, render: renderLeadRows },
  new: { title: 'New leads', subtitle: "Assigned to you, not yet actioned.", load: getNewLeads, render: renderLeadRows },
  documents: { title: 'Documents pending', subtitle: 'Uploaded documents awaiting your verification.', load: getDocumentsPending, render: renderDocumentRows },
  lenders: { title: 'Lender updates', subtitle: 'Recent activity across your leads\' lender deals.', load: getLenderUpdates, render: renderLenderUpdateRows },
};

function leadLink(leadId) {
  return `../../lead-management/public/index.html?openLead=${leadId}`;
}

function renderLeadRows(leads) {
  document.getElementById('listHead').innerHTML = '<tr><th>Student</th><th>Course / University</th><th>Loan amount</th><th>Stage</th><th>Next follow-up</th></tr>';
  const body = document.getElementById('listBody');
  if (leads.length === 0) {
    body.innerHTML = `<tr><td colspan="5">${emptyState('fa-inbox', 'Nothing here', 'Leads will show up here as they\'re assigned to you or as their status changes.')}</td></tr>`;
    return;
  }
  body.innerHTML = leads.map((l) => `
    <tr onclick="window.location.href='${leadLink(l.id)}'">
      <td><strong>${escapeHtml(l.student_name)}</strong><div style="font-size:12px;color:var(--ink-500);">${escapeHtml(l.student_phone)}</div></td>
      <td>${escapeHtml(l.course_name || '–')}${l.university_name ? ' · ' + escapeHtml(l.university_name) : ''}</td>
      <td>${formatCurrency(l.loan_amount_requested, l.currency)}</td>
      <td><span class="badge badge-accent">${escapeHtml(l.lead_stages?.name || '–')}</span></td>
      <td class="${isOverdue(l.next_follow_up_at) ? 'overdue-text' : ''}">${formatDateTime(l.next_follow_up_at)}</td>
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
    <tr onclick="window.location.href='${leadLink(d.leads?.id)}'">
      <td>${escapeHtml(d.document_types?.name || 'Document')}<div style="font-size:12px;color:var(--ink-500);">${escapeHtml(d.file_name)}</div></td>
      <td>${escapeHtml(d.leads?.student_name || '–')}</td>
      <td>${formatDateTime(d.uploaded_at)}</td>
    </tr>
  `).join('');
}

function renderLenderUpdateRows(events) {
  document.getElementById('listHead').innerHTML = '<tr><th>Event</th><th>Lender</th><th>Student</th><th>When</th></tr>';
  const body = document.getElementById('listBody');
  if (events.length === 0) {
    body.innerHTML = `<tr><td colspan="4">${emptyState('fa-building-columns', 'No recent lender activity', 'Updates will appear here as lenders act on your shared deals.')}</td></tr>`;
    return;
  }
  body.innerHTML = events.map((ev) => `
    <tr onclick="window.location.href='${leadLink(ev.deals?.leads?.id)}'">
      <td><span class="badge badge-accent">${escapeHtml(ev.event_type)}</span>${ev.remarks ? '<div style="font-size:12px;color:var(--ink-500);margin-top:3px;">' + escapeHtml(ev.remarks) + '</div>' : ''}</td>
      <td>${escapeHtml(ev.deals?.lenders?.name || '–')}</td>
      <td>${escapeHtml(ev.deals?.leads?.student_name || '–')}</td>
      <td>${formatDateTime(ev.created_at)}</td>
    </tr>
  `).join('');
}

const VIEW_CRUMBS = {
  dashboard: '', assigned: 'Assigned Leads', followups: "Today's Follow-ups",
  new: 'New Leads', documents: 'Documents Pending', lenders: 'Lender Updates',
  calls: 'Calls', tasks: 'Tasks',
};

async function loadView(key) {
  document.getElementById('dashboardView').hidden = key !== 'dashboard';
  document.getElementById('listView').hidden = key === 'tasks' || key === 'dashboard' || key === 'calls';
  document.getElementById('tasksView').hidden = key !== 'tasks';
  document.getElementById('callsView').hidden = key !== 'calls';
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === key));
  setBreadcrumb(VIEW_CRUMBS[key] ? [VIEW_CRUMBS[key]] : []);

  if (key === 'dashboard') {
    document.getElementById('viewTitle').textContent = 'Dashboard';
    document.getElementById('viewSubtitle').textContent = 'Your leads at a glance.';
    await renderRmDashboard();
    return;
  }

  if (key === 'tasks') {
    document.getElementById('viewTitle').textContent = 'Tasks';
    document.getElementById('viewSubtitle').textContent = 'Your personal to-do list.';
    await refreshTasks();
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
    const data = await view.load();
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

  const connected = calls.filter((c) => c.event_type === 'Connected').length;
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
    <tr onclick="window.location.href='${leadLink(c.leads?.id)}'">
      <td><strong>${escapeHtml(c.leads?.student_name || '–')}</strong></td>
      <td><span class="badge ${c.event_type === 'Connected' ? 'badge-success' : 'badge-neutral'}">${escapeHtml(c.event_type)}</span></td>
      <td>${escapeHtml(truncate(c.remarks, 60))}</td>
      <td>${formatDateTime(c.created_at)}</td>
    </tr>
  `).join('');
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

async function renderRmDashboard() {
  const leads = await getAssignedLeads();
  const now = Date.now();
  const overdue = leads.filter((l) => l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() < now);
  const today = new Date().toISOString().slice(0, 10);
  const [overdueTasks, tatBreaches] = await Promise.all([
    getMyTasks().then((tasks) => tasks.filter((t) => !t.is_completed && t.due_date && t.due_date < today)),
    getMyTatBreachedDeals(),
  ]);

  document.getElementById('rmDashStats').innerHTML = [
    [leads.length, 'Assigned leads', 'fa-inbox', 'var(--accent)'],
    [overdue.length, 'Overdue follow-ups', 'fa-clock', 'var(--danger)'],
    [leads.length - overdue.length, 'On track', 'fa-circle-check', 'var(--success)'],
  ].map(([value, label, icon, accent]) => `<div class="stat-card" style="--stat-accent:${accent};"><div class="stat-icon"><i class="fa-solid ${icon}"></i></div><div class="amount" style="color:${accent};">${value}</div><div class="stat-label">${label}</div></div>`).join('');

  const stageCounts = {};
  leads.forEach((l) => {
    const name = l.lead_stages?.name || 'Unknown';
    stageCounts[name] = (stageCounts[name] || 0) + 1;
  });
  const maxCount = Math.max(...Object.values(stageCounts), 1);
  document.getElementById('rmDashStageBreakdown').innerHTML = Object.entries(stageCounts).map(([name, count]) => `
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;"><span>${escapeHtml(name)}</span><span class="amount">${count}</span></div>
      <div style="background:var(--bg-hover);border-radius:4px;height:8px;"><div style="background:var(--accent);width:${(count / maxCount) * 100}%;height:100%;border-radius:4px;"></div></div>
    </div>
  `).join('') || emptyState('fa-diagram-project', 'No leads assigned yet', 'Once leads are assigned to you, their stage breakdown will show here.');

  const overdueFollowUpHtml = overdue.slice(0, 8).map((l) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(l.student_name)}</span><span class="badge badge-danger">${formatDateTime(l.next_follow_up_at)}</span></div>`).join('');
  const overdueTaskHtml = overdueTasks.slice(0, 8).map((t) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(t.title)}${t.leads ? ' · ' + escapeHtml(t.leads.student_name) : ''}</span><span class="badge badge-danger">Overdue task</span></div>`).join('');
  const tatBreachHtml = tatBreaches.slice(0, 8).map((d) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(d.student || '–')}</span><span class="badge badge-warning">Overstayed ${escapeHtml(d.stage)} (${d.thresholdDays}d TAT)</span></div>`).join('');

  document.getElementById('rmDashAttention').innerHTML = (overdue.length + overdueTasks.length + tatBreaches.length) === 0
    ? emptyState('fa-circle-check', 'Nothing overdue', 'No overdue follow-ups, tasks, or TAT breaches right now — nice work.')
    : overdueFollowUpHtml + overdueTaskHtml + tatBreachHtml;
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

  document.getElementById('btnNewLead').addEventListener('click', open);
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
  mountTopbar({ app: 'rm-workspace', user: currentUser });

  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); loadView(el.dataset.view); });
  });
  initLeadModal();
  initCallsPeriodToggle();

  const leadOptions = await getMyOpenLeadsForTaskLink();
  document.getElementById('taskLeadSelect').insertAdjacentHTML('beforeend', leadOptions.map((l) => `<option value="${l.id}">${escapeHtml(l.student_name)}</option>`).join(''));

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

bootstrap();
