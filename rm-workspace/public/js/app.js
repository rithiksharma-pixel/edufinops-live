import { getCurrentUser } from './services/authService.js';
import { getAssignedLeads, getTodaysFollowUps, getNewLeads, getDocumentsPending, getLenderUpdates, getMyTatBreachedDeals } from './services/dashboardService.js';
import { getMyTasks, createTask, toggleTaskComplete, getMyOpenLeadsForTaskLink } from './services/taskService.js';
import { formatCurrency, formatDateTime, formatDate, isOverdue, escapeHtml } from './utils/validation.js';

let currentUser;
const toastEl = document.getElementById('toast');
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
    body.innerHTML = '<tr><td colspan="5" class="empty-state">Nothing here.</td></tr>';
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
    body.innerHTML = '<tr><td colspan="3" class="empty-state">Nothing pending review.</td></tr>';
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
    body.innerHTML = '<tr><td colspan="4" class="empty-state">No recent lender activity.</td></tr>';
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

async function loadView(key) {
  document.getElementById('dashboardView').hidden = key !== 'dashboard';
  document.getElementById('listView').hidden = key === 'tasks' || key === 'dashboard';
  document.getElementById('tasksView').hidden = key !== 'tasks';
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === key));

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
    container.innerHTML = '<p class="empty-state">No tasks yet.</p>';
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

async function renderRmDashboard() {
  const leads = await getAssignedLeads();
  const now = Date.now();
  const overdue = leads.filter((l) => l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() < now);
  const today = new Date().toISOString().slice(0, 10);
  const [overdueTasks, tatBreaches] = await Promise.all([
    getMyTasks().then((tasks) => tasks.filter((t) => !t.is_completed && t.due_date && t.due_date < today)),
    getMyTatBreachedDeals(),
  ]);

  document.getElementById('rmDashStats').innerHTML = `
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;">${leads.length}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">Assigned leads</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;color:var(--danger);">${overdue.length}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">Overdue follow-ups</div></div>
    <div class="stat-card" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px 18px;"><div class="amount" style="font-size:24px;font-weight:600;color:var(--success);">${leads.length - overdue.length}</div><div style="font-size:12px;color:var(--ink-500);margin-top:4px;">On track</div></div>
  `;

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
  `).join('') || '<p class="empty-state">No leads assigned yet.</p>';

  const overdueFollowUpHtml = overdue.slice(0, 8).map((l) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(l.student_name)}</span><span class="badge badge-danger">${formatDateTime(l.next_follow_up_at)}</span></div>`).join('');
  const overdueTaskHtml = overdueTasks.slice(0, 8).map((t) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(t.title)}${t.leads ? ' · ' + escapeHtml(t.leads.student_name) : ''}</span><span class="badge badge-danger">Overdue task</span></div>`).join('');
  const tatBreachHtml = tatBreaches.slice(0, 8).map((d) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${escapeHtml(d.student || '–')}</span><span class="badge badge-warning">Overstayed ${escapeHtml(d.stage)} (${d.thresholdDays}d TAT)</span></div>`).join('');

  document.getElementById('rmDashAttention').innerHTML = (overdue.length + overdueTasks.length + tatBreaches.length) === 0
    ? '<p class="empty-state">Nothing overdue — nice work.</p>'
    : overdueFollowUpHtml + overdueTaskHtml + tatBreachHtml;
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

  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); loadView(el.dataset.view); });
  });

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
