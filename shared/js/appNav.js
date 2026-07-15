// =========================================================
// SHARED CROSS-APP NAVIGATION — one source of truth for how a
// signed-in user moves between the portals, where they are, and how
// they sign out. Imported by every app; renders a top "chrome" bar
// into a `<div id="ztTopbar">` placeholder at the start of <main>.
//
// Design goals this solves:
//   1. Role-aware app switching — a user only ever sees portals their
//      role can actually enter (no dead links to Admin Dashboard for a
//      Counselor, etc.). The access matrix below mirrors roleRoutes.js
//      and the apps' real RLS scoping.
//   2. Sense of place — breadcrumbs show App › section › detail, so
//      deep views (a lead's Lenders tab) aren't disorienting.
//   3. Consistent sign-out — every app, one control, same behavior.
//   4. Mobile navigation — sidebars hide under 860px; this bar stays,
//      so the app switcher is the primary nav on small screens.
//
// This module imports NOTHING app-specific (each app's supabase client
// lives at a different relative path). The caller passes in the already
// -fetched user; sign-out is handled here by clearing the Supabase
// session from localStorage and returning to the login page.
// =========================================================

const SUPABASE_REF = 'wgzgqbfankdbqxxcesci';
const LOGIN_PATH = '/authentication/public/login.html';

// The full portal catalog. `roles` = which role names may navigate to
// this destination. Keep in sync with authentication/js/config/roleRoutes.js.
const APPS = [
  { key: 'admin-dashboard',   label: 'Admin Dashboard',   icon: 'fa-gauge-high',       path: '/admin-dashboard/public/index.html',        roles: ['Admin'] },
  { key: 'manager-dashboard', label: 'Manager Dashboard', icon: 'fa-chart-line',       path: '/manager-dashboard/public/index.html',      roles: ['Admin', 'Manager', 'Associate Team Manager'] },
  { key: 'rm-workspace',      label: 'RM Workspace',      icon: 'fa-user-tie',         path: '/rm-workspace/public/index.html',           roles: ['Admin', 'Relationship Manager'] },
  { key: 'lead-management',   label: 'Lead Management',   icon: 'fa-diagram-project',  path: '/lead-management/public/index.html',        roles: ['Admin', 'Manager', 'Associate Team Manager', 'Relationship Manager', 'Counselor', 'Business Development', 'Consultant'] },
  { key: 'consultant-portal', label: 'Consultant Portal', icon: 'fa-handshake',        path: '/consultant-portal/public/index.html',      roles: ['Admin', 'Consultant'] },
  { key: 'lender-pipeline',   label: 'Lender Pipeline',   icon: 'fa-building-columns', path: '/lender-pipeline/public/index.html',        roles: ['Admin', 'Lender'] },
  { key: 'user-management',   label: 'User Management',   icon: 'fa-users',            path: '/authentication/public/users-admin.html',   roles: ['Admin', 'Manager', 'Associate Team Manager'] },
];

const state = { app: null, user: null, crumbs: [] };

function accessibleApps(role) {
  return APPS.filter((a) => a.roles.includes(role));
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
}

/**
 * Mount / refresh the top chrome bar.
 * @param {{app:string, user:{fullName?:string,email?:string,role:string}, crumbs?:Array}} opts
 */
export function mountTopbar({ app, user, crumbs }) {
  state.app = app;
  state.user = user || null;
  if (crumbs) state.crumbs = crumbs;
  render();
}

/**
 * Set the in-app breadcrumb trail (everything after the app switcher).
 * Each crumb is a string, or { label, href, onClick }.
 * Call with [] to clear back to just the app root.
 */
export function setBreadcrumb(crumbs) {
  state.crumbs = Array.isArray(crumbs) ? crumbs : [];
  render();
}

async function doSignOut() {
  try {
    // Clear every Supabase auth entry (access + refresh token) so the
    // session can't be silently refreshed in this browser after logout.
    Object.keys(localStorage)
      .filter((k) => k.startsWith('sb-') || k.includes(SUPABASE_REF))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* localStorage may be unavailable; redirect regardless */ }
  window.location.href = LOGIN_PATH;
}

function render() {
  const host = document.getElementById('ztTopbar');
  if (!host) return;

  const current = APPS.find((a) => a.key === state.app);
  const currentLabel = current ? current.label : 'Zolve Tangent';
  const currentIcon = current ? current.icon : 'fa-layer-group';
  const apps = state.user ? accessibleApps(state.user.role) : [];
  const showSwitcher = apps.length > 1; // no menu if there's nowhere else to go

  const menuItems = apps.map((a) => `
    <a class="zt-switch-item ${a.key === state.app ? 'current' : ''}" href="${a.path}" role="menuitem">
      <i class="fa-solid ${a.icon}"></i>
      <span>${escapeHtml(a.label)}</span>
      ${a.key === state.app ? '<i class="fa-solid fa-check zt-switch-check"></i>' : ''}
    </a>`).join('');

  const crumbHtml = state.crumbs.map((c) => {
    const label = typeof c === 'string' ? c : c.label;
    const inner = `<span>${escapeHtml(label)}</span>`;
    const node = (typeof c === 'object' && c.href)
      ? `<a class="zt-crumb-link" href="${c.href}">${inner}</a>`
      : (typeof c === 'object' && c.onClick)
        ? `<button type="button" class="zt-crumb-link" data-crumb-action>${inner}</button>`
        : inner;
    return `<i class="fa-solid fa-angle-right zt-crumb-sep"></i>${node}`;
  }).join('');

  host.innerHTML = `
    <div class="zt-topbar-left">
      <div class="zt-appswitch ${showSwitcher ? '' : 'static'}">
        <button type="button" class="zt-appswitch-btn" ${showSwitcher ? 'aria-haspopup="true" aria-expanded="false"' : 'disabled'}>
          <span class="zt-appswitch-mark"><i class="fa-solid ${currentIcon}"></i></span>
          <span class="zt-appswitch-label">${escapeHtml(currentLabel)}</span>
          ${showSwitcher ? '<i class="fa-solid fa-angle-down zt-appswitch-caret"></i>' : ''}
        </button>
        ${showSwitcher ? `<div class="zt-switch-menu" role="menu" hidden>
          <div class="zt-switch-menu-head">Switch to</div>
          ${menuItems}
        </div>` : ''}
      </div>
      <nav class="zt-crumbs" aria-label="Breadcrumb">${crumbHtml}</nav>
    </div>
    <div class="zt-topbar-right">
      ${state.user ? `
        <div class="zt-user">
          <div class="zt-user-avatar">${escapeHtml(initials(state.user.fullName))}</div>
          <div class="zt-user-meta">
            <span class="zt-user-name">${escapeHtml(state.user.fullName || '')}</span>
            <span class="zt-user-role">${escapeHtml(state.user.role || '')}</span>
          </div>
        </div>` : ''}
      <button type="button" class="zt-signout" title="Sign out"><i class="fa-solid fa-arrow-right-from-bracket"></i><span>Sign out</span></button>
    </div>
  `;

  wireEvents(host);
}

function wireEvents(host) {
  const switchBtn = host.querySelector('.zt-appswitch-btn');
  const menu = host.querySelector('.zt-switch-menu');
  if (switchBtn && menu) {
    const close = () => { menu.hidden = true; switchBtn.setAttribute('aria-expanded', 'false'); };
    const open = () => { menu.hidden = false; switchBtn.setAttribute('aria-expanded', 'true'); };
    switchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  const signout = host.querySelector('.zt-signout');
  if (signout) signout.addEventListener('click', doSignOut);

  // Wire onClick crumbs in the order they appear in the trail.
  const actionCrumbs = state.crumbs.filter((c) => typeof c === 'object' && c.onClick);
  host.querySelectorAll('[data-crumb-action]').forEach((btn, i) => {
    const c = actionCrumbs[i];
    if (c) btn.addEventListener('click', c.onClick);
  });
}

export { APPS };
