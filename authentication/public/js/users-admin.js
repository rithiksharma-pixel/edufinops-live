import { getCurrentUserProfile } from './services/authService.js';
import {
  getRoles, getAllUsers, getPossibleManagers, getPendingInvitations,
  inviteUser, revokeInvitation, changeUserRole, changeReportingManager,
  deactivateUser, reactivateUser, getLenders, getLenderBranches,
  getTeams, changeUserTeam,
} from './services/userAdminService.js';

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

let roles = [];
let managers = [];
let lenders = [];
let teams = [];

async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  const users = await getAllUsers();
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No users yet.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  users.forEach((u) => {
    const tr = document.createElement('tr');
    const roleOptions = roles.map((r) => `<option value="${r.id}" ${r.name === u.roles?.name ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
    const managerOptions = `<option value="">None</option>` + managers.map((m) => `<option value="${m.id}" ${m.full_name === u.reporting_manager?.full_name ? 'selected' : ''}>${escapeHtml(m.full_name)}</option>`).join('');
    const isManager = u.roles?.name === 'Manager';
    const teamCell = isManager
      ? `<select class="inline-select" data-team-for="${u.id}"><option value="">None</option>${teams.map((t) => `<option value="${t.id}" ${t.id === u.team_id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>`
      : '<span style="color:var(--ink-500);">–</span>';
    tr.innerHTML = `
      <td class="name-cell">${escapeHtml(u.full_name)}<div style="font-size:12px;color:var(--ink-500);font-weight:400;">${escapeHtml(u.email)}</div></td>
      <td><select class="inline-select" data-role-for="${u.id}">${roleOptions}</select></td>
      <td><select class="inline-select" data-manager-for="${u.id}">${managerOptions}</select></td>
      <td>${teamCell}</td>
      <td><span class="badge ${u.is_active ? 'badge-success' : 'badge-neutral'}">${u.is_active ? 'Active' : 'Deactivated'}</span></td>
      <td><button class="row-action-btn ${u.is_active ? 'danger' : ''}" data-toggle-active="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Reactivate'}</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-team-for]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      try {
        await changeUserTeam(e.target.dataset.teamFor, e.target.value || null);
        showToast('Team updated.');
      } catch (err) {
        showToast('Could not change team.', true);
      }
    });
  });

  tbody.querySelectorAll('[data-role-for]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      try {
        await changeUserRole(e.target.dataset.roleFor, e.target.value, 'Changed via Manage Users');
        showToast('Role updated.');
        await loadUsers();
      } catch (err) {
        showToast('Could not change role.', true);
      }
    });
  });

  tbody.querySelectorAll('[data-manager-for]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      try {
        await changeReportingManager(e.target.dataset.managerFor, e.target.value || null, 'Changed via Manage Users');
        showToast('Reporting manager updated.');
      } catch (err) {
        showToast('Could not change reporting manager.', true);
      }
    });
  });

  tbody.querySelectorAll('[data-toggle-active]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const userId = e.target.dataset.toggleActive;
      const isActive = e.target.dataset.active === 'true';
      try {
        if (isActive) await deactivateUser(userId, 'Deactivated via Manage Users');
        else await reactivateUser(userId, 'Reactivated via Manage Users');
        showToast(isActive ? 'User deactivated.' : 'User reactivated.');
        await loadUsers();
      } catch (err) {
        showToast('Could not update this user.', true);
      }
    });
  });
}

async function loadInvitations() {
  const tbody = document.getElementById('invitesTableBody');
  const invites = await getPendingInvitations();
  if (invites.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No pending invitations.</td></tr>';
    return;
  }
  tbody.innerHTML = invites.map((inv) => `
    <tr>
      <td>${escapeHtml(inv.full_name)}</td>
      <td>${escapeHtml(inv.email)}</td>
      <td><span class="badge badge-accent">${escapeHtml(inv.roles?.name || '–')}</span></td>
      <td>${new Date(inv.invited_at).toLocaleDateString()}</td>
      <td>${new Date(inv.expires_at).toLocaleDateString()}</td>
      <td><button class="row-action-btn danger" data-revoke="${inv.id}">Revoke</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      try {
        await revokeInvitation(e.target.dataset.revoke);
        showToast('Invitation revoked.');
        await loadInvitations();
      } catch (err) {
        showToast('Could not revoke this invitation.', true);
      }
    });
  });
}

function initInviteModal() {
  const overlay = document.getElementById('inviteModalOverlay');
  const form = document.getElementById('inviteForm');
  const roleSelect = document.getElementById('inviteRoleSelect');
  const managerField = document.getElementById('managerField');
  const managerSelect = document.getElementById('inviteManagerSelect');
  const teamField = document.getElementById('teamField');
  const teamSelect = document.getElementById('inviteTeamSelect');
  const lenderOrgField = document.getElementById('lenderOrgField');
  const lenderOrgSelect = document.getElementById('inviteLenderOrgSelect');
  const lenderBranchField = document.getElementById('lenderBranchField');
  const lenderBranchSelect = document.getElementById('inviteLenderBranchSelect');

  roleSelect.innerHTML = roles.map((r) => `<option value="${r.id}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
  managerSelect.innerHTML = `<option value="">None</option>` + managers.map((m) => `<option value="${m.id}">${escapeHtml(m.full_name)}</option>`).join('');
  teamSelect.innerHTML = `<option value="">Select…</option>` + teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  lenderOrgSelect.innerHTML = `<option value="">Select…</option>` + lenders.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

  function updateFieldVisibility() {
    const selectedName = roleSelect.selectedOptions[0]?.dataset.name;
    managerField.hidden = !['Relationship Manager', 'Counselor', 'Business Development'].includes(selectedName);
    teamField.hidden = selectedName !== 'Manager';
    if (selectedName !== 'Manager') teamSelect.value = '';
    const isLender = selectedName === 'Lender';
    lenderOrgField.hidden = !isLender;
    lenderBranchField.hidden = !isLender;
    if (!isLender) {
      lenderOrgSelect.value = '';
      lenderBranchSelect.innerHTML = '';
    }
  }
  roleSelect.addEventListener('change', updateFieldVisibility);
  updateFieldVisibility();

  lenderOrgSelect.addEventListener('change', async () => {
    lenderBranchSelect.innerHTML = '<option value="">Loading…</option>';
    if (!lenderOrgSelect.value) {
      lenderBranchSelect.innerHTML = '<option value="">Select a lender first</option>';
      return;
    }
    try {
      const branches = await getLenderBranches(lenderOrgSelect.value);
      lenderBranchSelect.innerHTML = branches.length
        ? `<option value="">Select…</option>` + branches.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
        : '<option value="">No branches set up yet — add one in Admin Settings</option>';
    } catch (err) {
      lenderBranchSelect.innerHTML = '<option value="">Could not load branches</option>';
    }
  });

  document.getElementById('btnInvite').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseInviteModal').addEventListener('click', () => { overlay.hidden = true; });
  document.getElementById('btnCancelInvite').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    if (!payload.full_name || !payload.email || !payload.role_id) {
      showToast('Fill in name, email, and role.', true);
      return;
    }
    const selectedRoleName = roleSelect.selectedOptions[0]?.dataset.name;
    if (selectedRoleName === 'Lender' && (!payload.lender_organization_id || !payload.lender_branch_id)) {
      showToast('Select the lender institution and branch for this person.', true);
      return;
    }
    if (selectedRoleName === 'Manager' && !payload.team_id) {
      showToast('Select the team this Manager leads.', true);
      return;
    }
    const btn = document.getElementById('btnSubmitInvite');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await inviteUser({
        email: payload.email.trim(),
        fullName: payload.full_name.trim(),
        roleId: payload.role_id,
        reportingManagerId: payload.reporting_manager_id || null,
        lenderOrganizationId: payload.lender_organization_id || null,
        lenderBranchId: payload.lender_branch_id || null,
        teamId: payload.team_id || null,
      });
      showToast('Invitation sent.');
      overlay.hidden = true;
      form.reset();
      await loadInvitations();
    } catch (err) {
      showToast(err.message || 'Could not send this invite.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'Send invite';
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function bootstrap() {
  try {
    const profile = await getCurrentUserProfile();
    if (profile.role !== 'Admin') {
      document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">This page is only available to Admins.</div>';
      return;
    }
  } catch (err) {
    document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">Please <a href="login.html">sign in</a> first.</div>';
    return;
  }

  roles = await getRoles();
  managers = await getPossibleManagers();
  lenders = await getLenders();
  teams = await getTeams();
  initInviteModal();
  await Promise.all([loadUsers(), loadInvitations()]);
}

bootstrap();
