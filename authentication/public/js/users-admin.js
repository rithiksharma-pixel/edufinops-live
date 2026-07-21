import { getCurrentUser } from './services/authService.js';
import { escapeHtml, EMAIL_REGEX } from '../../../shared/js/utils.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import {
  getRoles, getAllUsers, getPossibleManagers, getPendingInvitations,
  inviteUser, revokeInvitation, changeUserRole, changeReportingManager,
  deactivateUser, reactivateUser, getLenders, getLenderBranches,
  getTeams, changeUserTeam,
} from './services/userAdminService.js';
import { whatsappPortalUrl } from './whatsappLink.js';

/**
 * "Send portal link" button for a roster/invite row. Renders a disabled
 * hint instead of a dead link when there's no phone on record, so it's
 * obvious WHY the action isn't available rather than the button just
 * being missing. Deactivated users get nothing — there's no portal to
 * send them to.
 */
function waButton({ fullName, email, phone, roleName, pending, active }) {
  if (!active) return '';
  const url = whatsappPortalUrl({ fullName, email, phone, roleName, origin: window.location.origin, pending });
  if (!url) {
    return '<button class="row-action-btn" disabled title="No phone number on record for this person">WhatsApp</button>';
  }
  return `<a class="row-action-btn wa-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Opens WhatsApp with the message ready — you tap send"><i class="fa-brands fa-whatsapp"></i> Send link</a>`;
}

let roles = [];
let managers = [];
let lenders = [];
let teams = [];
let currentUserProfile = null;

/**
 * "Full Name — Team" for a manager-picker option. The reporting-manager
 * dropdowns used to show only names, with no way to tell a Bangalore
 * manager from a Hyderabad one apart — the likely real cause behind any
 * "why can this RM see the other team's leads" report, since nothing
 * stops a reporting_manager_id from crossing team lines and this was
 * the one place a person picking it had no visual cue they'd done so.
 */
function managerLabel(m) {
  const teamName = teams.find((t) => t.id === m.team_id)?.name;
  return `${m.full_name}${teamName ? ` — ${teamName}` : ''}`;
}

// Which roles each inviter is allowed to hand out — mirrors invite_user()'s
// RPC-level scoping (see deployment/009_associate_team_manager_role_migration.sql).
// This is convenience/UX only; the RPC re-validates regardless.
const INVITABLE_ROLES_BY_INVITER = {
  Admin: null, // null = no restriction, every role is offered
  Manager: ['Relationship Manager', 'Counselor', 'Business Development', 'Associate Team Manager'],
  'Associate Team Manager': ['Relationship Manager', 'Counselor', 'Business Development'],
};

async function loadUsers() {
  const tbody = document.getElementById('usersTableBody');
  const users = await getAllUsers();
  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">${emptyState('fa-users', 'No users yet', 'Invite your first teammate and they will show up here.')}</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  users.forEach((u) => {
    const tr = document.createElement('tr');
    const roleOptions = roles.map((r) => `<option value="${r.id}" ${r.name === u.roles?.name ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
    const managerOptions = `<option value="">None</option>` + managers.map((m) => `<option value="${m.id}" ${m.full_name === u.reporting_manager?.full_name ? 'selected' : ''}>${escapeHtml(managerLabel(m))}</option>`).join('');
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
      <td class="row-actions">${waButton({ fullName: u.full_name, email: u.email, phone: u.phone, roleName: u.roles?.name, pending: false, active: u.is_active })}<button class="row-action-btn ${u.is_active ? 'danger' : ''}" data-toggle-active="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Reactivate'}</button></td>
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
    tbody.innerHTML = `<tr><td colspan="6">${emptyState('fa-envelope-open-text', 'No pending invitations', 'Invitations you send will wait here until the person accepts.')}</td></tr>`;
    return;
  }
  tbody.innerHTML = invites.map((inv) => `
    <tr>
      <td>${escapeHtml(inv.full_name)}</td>
      <td>${escapeHtml(inv.email)}</td>
      <td><span class="badge badge-accent">${escapeHtml(inv.roles?.name || '–')}</span></td>
      <td>${new Date(inv.invited_at).toLocaleDateString()}</td>
      <td>${new Date(inv.expires_at).toLocaleDateString()}</td>
      <td class="row-actions">${waButton({ fullName: inv.full_name, email: inv.email, phone: inv.phone, roleName: inv.roles?.name, pending: true, active: true })}<button class="row-action-btn danger" data-revoke="${inv.id}">Revoke</button></td>
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

  const isAdmin = currentUserProfile?.role === 'Admin';
  const allowedRoleNames = INVITABLE_ROLES_BY_INVITER[currentUserProfile?.role] ?? [];
  const invitableRoles = isAdmin ? roles : roles.filter((r) => allowedRoleNames.includes(r.name));

  roleSelect.innerHTML = invitableRoles.map((r) => `<option value="${r.id}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
  teamSelect.innerHTML = `<option value="">Select…</option>` + teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  lenderOrgSelect.innerHTML = `<option value="">Select…</option>` + lenders.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

  // For a non-Admin inviter, `managers` (from getPossibleManagers) is
  // already scoped to their own reporting subtree — but an Associate
  // Team Manager can't report to another Associate Team Manager, so
  // when THAT role is selected, narrow further to Manager-level choices.
  function managerChoicesFor(selectedName) {
    if (isAdmin) {
      return selectedName === 'Associate Team Manager'
        ? managers.filter((m) => m.roles?.name === 'Manager')
        : managers.filter((m) => ['Manager', 'Associate Team Manager'].includes(m.roles?.name));
    }
    return selectedName === 'Associate Team Manager'
      ? managers.filter((m) => m.roles?.name === 'Manager')
      : managers;
  }

  function updateFieldVisibility() {
    const selectedName = roleSelect.selectedOptions[0]?.dataset.name;
    managerField.hidden = !['Relationship Manager', 'Counselor', 'Business Development', 'Associate Team Manager'].includes(selectedName);
    if (!managerField.hidden) {
      const choices = managerChoicesFor(selectedName);
      managerSelect.innerHTML = `<option value="">${isAdmin ? 'None' : 'Default (you, or pick a specific one below)'}</option>` + choices.map((m) => `<option value="${m.id}">${escapeHtml(managerLabel(m))}</option>`).join('');
    }
    // Team is only meaningful for Manager/ATM invites, and only Admin needs
    // to pick it explicitly — a Manager/ATM inviting someone auto-inherits
    // their own team_id server-side (invite_user()).
    const teamRelevant = isAdmin && ['Manager', 'Associate Team Manager'].includes(selectedName);
    teamField.hidden = !teamRelevant;
    if (!teamRelevant) teamSelect.value = '';
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
    if (['Manager', 'Associate Team Manager'].includes(selectedRoleName) && !teamField.hidden && !payload.team_id) {
      showToast(`Select the team this ${selectedRoleName} belongs to.`, true);
      return;
    }
    const btn = document.getElementById('btnSubmitInvite');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await inviteUser({
        email: payload.email.trim(),
        fullName: payload.full_name.trim(),
        phone: payload.phone?.trim() || null,
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

// ---------- Bulk invite ----------
// One role for the whole batch; individual roles/teams get adjusted
// afterwards from the Active team roster (which already has inline
// role/manager/team editing). Lender is deliberately excluded — a Lender
// invite needs an institution + branch picked, so it stays one at a time.

/** `Name, email, phone (optional)` per line → {name,email,phone} or {error}. */
function parseBulkInviteLine(line) {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 2) return { error: 'needs at least "Name, email"' };
  const [name, email, phone = ''] = parts;
  if (!name) return { error: 'missing a name' };
  if (!EMAIL_REGEX.test(email)) return { error: `"${email}" is not a valid email` };
  return { name, email: email.toLowerCase(), phone };
}

function initBulkInviteModal() {
  const overlay = document.getElementById('bulkInviteModalOverlay');
  const roleSelect = document.getElementById('bulkInviteRoleSelect');
  const textEl = document.getElementById('bulkInviteText');
  const resultEl = document.getElementById('bulkInviteResult');
  const submitBtn = document.getElementById('btnSubmitBulkInvite');

  // Same role scoping as the single-invite modal, minus Lender.
  const isAdmin = currentUserProfile?.role === 'Admin';
  const allowedRoleNames = INVITABLE_ROLES_BY_INVITER[currentUserProfile?.role] ?? [];
  const bulkRoles = (isAdmin ? roles : roles.filter((r) => allowedRoleNames.includes(r.name)))
    .filter((r) => r.name !== 'Lender');
  roleSelect.innerHTML = bulkRoles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

  document.getElementById('bulkInviteFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) textEl.value = await file.text();
  });

  const close = () => { overlay.hidden = true; };
  document.getElementById('btnBulkInvite').addEventListener('click', () => {
    resultEl.hidden = true;
    resultEl.textContent = '';
    overlay.hidden = false;
  });
  document.getElementById('btnCloseBulkInviteModal').addEventListener('click', close);
  document.getElementById('btnCancelBulkInvite').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  submitBtn.addEventListener('click', async () => {
    const lines = textEl.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      resultEl.hidden = false;
      resultEl.classList.add('bulk-error');
      resultEl.textContent = 'Nothing to send — paste some lines first.';
      return;
    }

    const seen = new Set();
    const outcomes = [];
    const toInvite = [];
    for (const line of lines) {
      const parsed = parseBulkInviteLine(line);
      if (parsed.error) { outcomes.push(`✗ ${line} — ${parsed.error}`); continue; }
      if (seen.has(parsed.email)) { outcomes.push(`✗ ${parsed.email} — repeated in this list`); continue; }
      seen.add(parsed.email);
      toInvite.push(parsed);
    }

    submitBtn.disabled = true;
    resultEl.hidden = false;
    resultEl.classList.remove('bulk-error');
    let sent = 0;

    // Sequential on purpose: each invite is an RPC plus an email send, and
    // a per-row failure (say, a pending invite already exists) should name
    // the row it belongs to rather than surfacing as a tangle of rejections.
    for (const [i, person] of toInvite.entries()) {
      resultEl.textContent = `Inviting ${i + 1} of ${toInvite.length} — ${person.email}…\n` + outcomes.join('\n');
      try {
        await inviteUser({
          email: person.email,
          fullName: person.name,
          phone: person.phone || null,
          roleId: roleSelect.value,
          reportingManagerId: null,
          lenderOrganizationId: null,
          lenderBranchId: null,
          teamId: null,
        });
        sent++;
        outcomes.push(`✓ ${person.name} <${person.email}> — invited`);
      } catch (err) {
        outcomes.push(`✗ ${person.email} — ${err.message || 'failed'}`);
      }
    }

    submitBtn.disabled = false;
    const failed = outcomes.length - sent;
    resultEl.classList.toggle('bulk-error', failed > 0);
    resultEl.textContent = `Done: ${sent} invited${failed ? `, ${failed} skipped/failed` : ''}.\n` + outcomes.join('\n');
    if (sent > 0) {
      textEl.value = '';
      showToast(`${sent} invitation${sent === 1 ? '' : 's'} sent.`);
      if (currentUserProfile.role === 'Admin') await loadInvitations();
    }
  });
}

const INVITE_CAPABLE_ROLES = ['Admin', 'Manager', 'Associate Team Manager'];

async function bootstrap() {
  try {
    currentUserProfile = await getCurrentUser();
    if (!INVITE_CAPABLE_ROLES.includes(currentUserProfile.role)) {
      document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-lock" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Restricted</strong><span style="color:var(--ink-500);font-size:13px;">This page is only available to Admins, Managers, and Associate Team Managers.</span></div>';
      return;
    }
  } catch (err) {
    document.body.innerHTML = '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-right-to-bracket" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Sign-in required</strong><span style="color:var(--ink-500);font-size:13px;">Please <a href="login.html" style="color:var(--accent);">sign in</a> first.</span></div>';
    return;
  }

  mountTopbar({ app: 'user-management', user: currentUserProfile });

  const isAdmin = currentUserProfile.role === 'Admin';

  // The full "Active team" roster + role/manager/team editing and the
  // Pending Invitations table are Admin-only surfaces today (the
  // underlying change_user_role / change_reporting_manager / deactivate_user
  // RPCs and the invitations SELECT policy are still Admin-gated) — a
  // Manager/Associate Team Manager only gets the Invite flow here.
  if (!isAdmin) {
    document.querySelectorAll('.table-card').forEach((section) => { section.hidden = true; });
  }

  roles = await getRoles();
  managers = await getPossibleManagers(currentUserProfile);
  lenders = isAdmin ? await getLenders() : [];
  teams = await getTeams();
  initInviteModal();
  initBulkInviteModal();
  if (isAdmin) {
    await Promise.all([loadUsers(), loadInvitations()]);
  }
}

bootstrap();
