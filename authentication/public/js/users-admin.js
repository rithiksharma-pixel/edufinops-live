import { getCurrentUser } from './services/authService.js';
import { escapeHtml, EMAIL_REGEX } from '../../../shared/js/utils.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
import {
  getRoles, getAllUsers, getPossibleManagers, getPendingInvitations,
  inviteUser, revokeInvitation, resendInvitation, pendingInvitationFor,
  changeUserRole, changeReportingManager,
  deactivateUser, reactivateUser, getLenders, getLenderBranches,
  getTeams, changeUserTeam, removeUser, getRemovalBlockers,
} from './services/userAdminService.js';
import { whatsappPortalUrl } from './whatsappLink.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';

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
  const team = teams.find((t) => t.id === m.team_id);
  const where = team?.branch || team?.name;
  const isLead = teams.some((t) => t.lead_user_id === m.id);
  return `${m.full_name}${where ? ` (${where}${isLead ? ' · branch lead' : ''})` : ''}`;
}

// Which roles each inviter is allowed to hand out — mirrors invite_user()'s
// RPC-level scoping (see deployment/009_associate_team_manager_role_migration.sql).
// This is convenience/UX only; the RPC re-validates regardless.
const INVITABLE_ROLES_BY_INVITER = {
  Admin: null, // null = no restriction, every role is offered
  Manager: ['Relationship Manager', 'Counselor', 'Business Development', 'Associate Team Manager'],
  'Associate Team Manager': ['Relationship Manager', 'Counselor', 'Business Development'],
};

/**
 * Remove button for a roster row.
 *
 * Removal is a SOFT delete: 115 foreign keys point at users.id, so the row has
 * to survive for the audit trail to mean anything. What the button mostly does
 * is explain when removal is not possible yet -- disabled with the real reason
 * on hover, rather than letting someone click and get an error.
 *
 * Only an Admin sees it, and never on their own row.
 */
function removeButton(u, blocker, me) {
  if (me?.role !== 'Admin' || u.id === me?.id) return '';

  const held = (blocker?.rm_leads ?? 0) + (blocker?.manager_leads ?? 0);
  const reports = blocker?.direct_reports ?? 0;
  if (held || reports) {
    const bits = [];
    if (blocker.rm_leads) bits.push(`${blocker.rm_leads} lead${blocker.rm_leads === 1 ? '' : 's'}`);
    if (blocker.manager_leads) bits.push(`${blocker.manager_leads} as manager`);
    if (reports) bits.push(`${reports} report${reports === 1 ? '' : 's'}`);
    return `<button class="row-action-btn" disabled title="Reassign first: ${escapeHtml(bits.join(', '))}">Remove</button>`;
  }
  return `<button class="row-action-btn danger" data-remove-user="${u.id}" data-remove-name="${escapeHtml(u.full_name)}" title="Remove from the team">Remove</button>`;
}

// =========================================================
// Roster view state. The whole roster is loaded once (it is ~45 people) and
// the branch tabs and search are filters over it, so switching is instant
// and the tab counts always agree with the rows below them.
// =========================================================
const roster = { users: [], blockers: new Map(), branch: 'all', search: '' };

const teamOf = (u) => teams.find((t) => t.id === u.team_id);
const branchOf = (u) => teamOf(u)?.branch || null;

function rosterTabs() {
  const branches = [...new Set(teams.map((t) => t.branch).filter(Boolean))].sort();
  return [
    { id: 'all', label: 'Everyone', test: () => true },
    ...branches.map((b) => ({ id: b, label: b, test: (u) => branchOf(u) === b })),
    { id: 'none', label: 'No branch', test: (u) => !branchOf(u), alert: true },
  ];
}

async function loadUsers() {
  roster.users = await getAllUsers();
  // Fetched alongside the roster so Remove can say WHY it is unavailable.
  // A failure here must not take the whole table down, so it degrades to an
  // empty map and the button falls back to letting the RPC refuse.
  try { roster.blockers = await getRemovalBlockers(); } catch { roster.blockers = new Map(); }
  renderRoster();
}

function renderRoster() {
  const tbody = document.getElementById('usersTableBody');
  const blockers = roster.blockers;
  const tabs = rosterTabs();
  if (!tabs.some((t) => t.id === roster.branch)) roster.branch = 'all';
  const tab = tabs.find((t) => t.id === roster.branch);

  const tabsEl = document.getElementById('rosterTabs');
  tabsEl.innerHTML = tabs.map((t) => {
    const n = roster.users.filter(t.test).length;
    return `<button type="button" class="roster-tab ${t.id === roster.branch ? 'on' : ''} ${t.alert && n ? 'alert' : ''}" data-roster-tab="${escapeHtml(t.id)}">${escapeHtml(t.label)} <span class="n">${n}</span></button>`;
  }).join('');
  tabsEl.querySelectorAll('[data-roster-tab]').forEach((b) => b.addEventListener('click', () => {
    roster.branch = b.dataset.rosterTab; renderRoster();
  }));

  const q = roster.search.toLowerCase();
  // Grouped the way the business is: branch, then who they report to, then
  // name. Reading down a branch shows each sub-team together.
  const users = roster.users
    .filter(tab.test)
    .filter((u) => !q || (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
    .sort((a, b) => (branchOf(a) || 'zzz').localeCompare(branchOf(b) || 'zzz')
      || (a.reporting_manager?.full_name || '').localeCompare(b.reporting_manager?.full_name || '')
      || (a.full_name || '').localeCompare(b.full_name || ''));

  document.getElementById('rosterFoot').textContent =
    `${users.length} of ${roster.users.length} people${q ? ` matching "${roster.search}"` : ''}`;

  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">${roster.users.length === 0
      ? emptyState('fa-users', 'No users yet', 'Invite your first teammate and they will show up here.')
      : emptyState('fa-magnifying-glass', 'Nobody matches', 'Try a different name, or another branch.')}</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  users.forEach((u) => {
    const tr = document.createElement('tr');
    if (!u.is_active) tr.className = 'inactive';
    const roleOptions = roles.map((r) => `<option value="${r.id}" ${r.name === u.roles?.name ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
    // Match on id, not full_name — two teammates with the same name used to
    // select the wrong row (and the right one looked unset).
    const managerOptions = `<option value="">None</option>` + managers
      .filter((m) => m.id !== u.id)
      .map((m) => `<option value="${m.id}" ${m.id === u.reporting_manager_id ? 'selected' : ''}>${escapeHtml(managerLabel(m))}</option>`).join('');

    // Team follows manager (trg_users_inherit_team, deployment/066), so for
    // most people it is a fact to read, not a field to set. Only a Manager —
    // who can head a team — gets the picker.
    const team = teamOf(u);
    const isLead = team?.lead_user_id === u.id;
    const isManager = u.roles?.name === 'Manager';
    const teamCell = isManager
      ? `<select class="inline-select" data-team-for="${u.id}"><option value="">None</option>${teams.map((t) => `<option value="${t.id}" ${t.id === u.team_id ? 'selected' : ''}>${escapeHtml(t.branch ? `${t.branch} · ${t.name}` : t.name)}</option>`).join('')}</select>`
      : team
        ? `<span class="team-chip">${escapeHtml(team.branch || team.name)}</span>${team.branch ? `<span class="team-sub">${escapeHtml(team.name)}</span>` : ''}`
        : '<span class="team-none" title="Set a reporting manager and the team follows">No branch</span>';

    tr.innerHTML = `
      <td class="name-cell"><div class="person">${escapeHtml(u.full_name)}${isLead ? ' <span class="lead-badge" title="Heads this branch">Branch lead</span>' : ''}</div><div class="person-email">${escapeHtml(u.email)}</div></td>
      <td><select class="inline-select" data-role-for="${u.id}">${roleOptions}</select></td>
      <td><select class="inline-select" data-manager-for="${u.id}">${managerOptions}</select></td>
      <td class="team-cell">${teamCell}</td>
      <td><span class="badge ${u.is_active ? 'badge-success' : 'badge-neutral'}">${u.is_active ? 'Active' : 'Deactivated'}</span></td>
      <td class="row-actions">${waButton({ fullName: u.full_name, email: u.email, phone: u.phone, roleName: u.roles?.name, pending: false, active: u.is_active })}<button class="row-action-btn ${u.is_active ? 'danger' : ''}" data-toggle-active="${u.id}" data-active="${u.is_active}">${u.is_active ? 'Deactivate' : 'Reactivate'}</button>${removeButton(u, blockers.get(u.id), currentUserProfile)}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-team-for]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      try {
        await changeUserTeam(e.target.dataset.teamFor, e.target.value || null);
        showToast('Team updated.');
      } catch (err) {
        // Show the real reason (RLS denial, trigger guard, network) instead
        // of a blanket failure the user can't act on.
        console.error('changeUserTeam failed', err);
        showToast(`Could not change team: ${err.message || err}`, true);
        await loadUsers(); // snap the dropdown back to the stored value
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
        console.error('changeUserRole failed', err);
        showToast(`Could not change role: ${err.message || err}`, true);
        await loadUsers();
      }
    });
  });

  tbody.querySelectorAll('[data-manager-for]').forEach((select) => {
    select.addEventListener('change', async (e) => {
      try {
        await changeReportingManager(e.target.dataset.managerFor, e.target.value || null, 'Changed via Manage Users');
        showToast('Reporting manager updated.');
        await loadUsers(); // re-render so the saved manager is reflected everywhere
      } catch (err) {
        console.error('changeReportingManager failed', err);
        showToast(`Could not change reporting manager: ${err.message || err}`, true);
        await loadUsers();
      }
    });
  });

  tbody.querySelectorAll('[data-remove-user]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const userId = e.currentTarget.dataset.removeUser;
      const name = e.currentTarget.dataset.removeName;
      // Removal hides them everywhere, so it gets a real confirmation.
      if (!window.confirm(`Remove ${name} from the team?

They lose access immediately and disappear from every list. Their history stays on the records they touched. This is not reversible from this screen.`)) return;
      try {
        await removeUser(userId, 'Removed via Manage Users');
        showToast(`${name} removed.`);
        await loadUsers();
      } catch (err) {
        // The RPC names the exact counts blocking removal; passing that
        // straight through is far more useful than a generic failure.
        showToast(err?.message || 'Could not remove this user.', true);
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
      <td class="row-actions">${waButton({ fullName: inv.full_name, email: inv.email, phone: inv.phone, roleName: inv.roles?.name, pending: true, active: true })}<button class="row-action-btn" data-resend="${inv.id}">Resend</button><button class="row-action-btn danger" data-revoke="${inv.id}">Revoke</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-resend]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const el = e.currentTarget;
      el.disabled = true;
      try {
        await resendInvitation(el.dataset.resend);
        showToast('Invitation sent again.');
        await loadInvitations();
      } catch (err) {
        console.error(err);
        showToast(err.message || 'Could not resend this invitation.', true);
      } finally {
        el.disabled = false;
      }
    });
  });

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

  // No default role. The list is alphabetical, so the first option — and the
  // old default — was always "Admin": re-invites went out as Admin without
  // anyone choosing it. Relationship Manager is listed first as the usual case.
  const roleOrder = (r) => (r.name === 'Relationship Manager' ? 0 : r.name === 'Admin' ? 2 : 1);
  roleSelect.innerHTML = '<option value="" data-name="">Choose a role…</option>'
    + [...invitableRoles].sort((a, b) => roleOrder(a) - roleOrder(b) || a.name.localeCompare(b.name))
      .map((r) => `<option value="${r.id}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
  teamSelect.innerHTML = `<option value="">Select…</option>` + teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  lenderOrgSelect.innerHTML = `<option value="">Select…</option>` + lenders.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

  // For a non-Admin inviter, `managers` (from getPossibleManagers) is
  // already scoped to their own reporting subtree — but an Associate
  // Team Manager can't report to another Associate Team Manager, so
  // when THAT role is selected, narrow further to Manager-level choices.
  // A branch lead can be anyone's reporting manager whatever their role:
  // Julius heads Hyderabad as an Admin, and filtering on role alone left
  // the whole Hyderabad branch with no manager to pick. Admins who don't
  // lead a branch stay off the list — nobody should report to them by
  // accident. Sorted by branch, so the two branches read as two groups.
  const branchLeadIds = new Set(teams.map((t) => t.lead_user_id).filter(Boolean));
  const branchOf = (m) => teams.find((t) => t.id === m.team_id)?.branch || '~';
  const byBranch = (list) => [...list].sort((a, b) => branchOf(a).localeCompare(branchOf(b))
    || (branchLeadIds.has(b.id) - branchLeadIds.has(a.id))
    || a.full_name.localeCompare(b.full_name));

  function managerChoicesFor(selectedName) {
    if (isAdmin) {
      return byBranch(selectedName === 'Associate Team Manager'
        ? managers.filter((m) => m.roles?.name === 'Manager' || branchLeadIds.has(m.id))
        : managers.filter((m) => ['Manager', 'Associate Team Manager'].includes(m.roles?.name) || branchLeadIds.has(m.id)));
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
    // Admin can see and change everything, so it is never a quiet choice.
    if (selectedRoleName === 'Admin'
        && !window.confirm(`Invite ${payload.full_name} as an Admin?

Admins can see and change everything, including users and settings. For someone who works leads, choose Relationship Manager.`)) {
      return;
    }
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
      console.error(err);
      // A duplicate is not a dead end. Offer to resend the invitation that
      // is already waiting, rather than making someone close this dialog,
      // hunt down the row, revoke it, and re-key every field.
      const dup = /already has an invitation waiting/i.test(err.message || '');
      if (dup) {
        const email = payload.email.trim();
        const existingId = await pendingInvitationFor(email).catch(() => null);
        if (existingId && confirm(
          `${email} already has an invitation waiting.

`
          + 'Send it again now? The role, manager and team on the existing '
          + 'invitation are kept.')) {
          try {
            await resendInvitation(existingId);
            showToast('Invitation sent again.');
            overlay.hidden = true;
            form.reset();
            await loadInvitations();
            return;
          } catch (resendErr) {
            console.error(resendErr);
            showToast(resendErr.message || 'Could not resend that invitation.', true);
            return;
          }
        }
      }
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
  roleSelect.innerHTML = '<option value="">Choose a role…</option>'
    + [...bulkRoles].sort((a, b) => (a.name === 'Relationship Manager' ? -1 : b.name === 'Relationship Manager' ? 1 : 0) || (a.name === 'Admin') - (b.name === 'Admin') || a.name.localeCompare(b.name))
      .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

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
    if (!roleSelect.value) {
      resultEl.hidden = false;
      resultEl.classList.add('bulk-error');
      resultEl.textContent = 'Choose the role everyone in this list should get.';
      return;
    }
    if (roleSelect.selectedOptions[0]?.text === 'Admin'
        && !window.confirm('Invite everyone in this list as an Admin?' + String.fromCharCode(10, 10) + 'Admins can see and change everything, including users and settings.')) {
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

  // Any failure below used to reject unhandled, leaving the page half-built
  // — an empty roster and empty Team / Reporting manager dropdowns with no
  // hint as to why. Surface it instead so the cause is visible.
  try {
    roles = await getRoles();
    managers = await getPossibleManagers(currentUserProfile);
    lenders = isAdmin ? await getLenders() : [];
    teams = await getTeams();
    initInviteModal();
    initBulkInviteModal();
    if (isAdmin) {
      let rosterDebounce;
      document.getElementById('rosterSearch').addEventListener('input', (e) => {
        clearTimeout(rosterDebounce);
        rosterDebounce = setTimeout(() => { roster.search = e.target.value.trim(); renderRoster(); }, 120);
      });
      await Promise.all([loadUsers(), loadInvitations()]);
    }
  } catch (err) {
    console.error('User management failed to load', err);
    showToast(`Could not load user management: ${err.message || err}`, true);
  }
}

guardBootstrap(bootstrap, 'User Management');