// =========================================================
// SHARED — Who may reach what.
//
// One catalog of every destination in the product and the roles allowed
// into each. It drives three things that used to disagree:
//
//   1. the sidebar app switcher (appNav renders from this),
//   2. each app's own sidebar sections (applyNavPermissions hides the
//      entries a role has no business seeing),
//   3. the page guard (guardDestination sends someone who typed a URL
//      they cannot use back to their own home screen).
//
// Before this, only admin-dashboard checked a role at boot. Every other app
// rendered for whoever asked. RLS meant the DATA was still correctly scoped
// — an RM opening the Manager Dashboard saw only their own leads — but they
// were looking at a manager's screen, with links to partner reporting that
// is not theirs to read. Correct data on the wrong surface is still wrong.
//
// This is navigation and presentation only. It is NOT the security boundary
// — RLS is, and it stays the thing that decides what rows anyone can touch.
// Removing a link never removes an authorisation.
// =========================================================

export const ROLES = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  ATM: 'Associate Team Manager',
  RM: 'Relationship Manager',
  COUNSELOR: 'Counselor',
  BD: 'Business Development',
  CONSULTANT: 'Consultant',
  LENDER: 'Lender',
};

const { ADMIN, MANAGER, ATM, RM, COUNSELOR, BD, CONSULTANT, LENDER } = ROLES;

/**
 * Every destination, in the order they should appear in navigation.
 *
 * `roles`     — who may open it.
 * `inNav`     — show it in the sidebar app list (false for a page that is
 *               already reachable from its parent app's own sidebar).
 */
export const DESTINATIONS = [
  { key: 'admin-dashboard', label: 'Admin Dashboard', icon: 'fa-gauge-high',
    path: '/admin-dashboard/public/index.html', roles: [ADMIN], inNav: true },

  { key: 'manager-dashboard', label: 'Manager Dashboard', icon: 'fa-chart-line',
    path: '/manager-dashboard/public/index.html', roles: [ADMIN, MANAGER, ATM], inNav: true },

  // Partner Reports carries both cuts — by consultancy and by BD manager —
  // so Admin reaching it directly is the "admin view plus partner and BD
  // reports" ask, without making them hop through the Manager Dashboard.
  { key: 'partner-reports', label: 'Partner & BD Reports', icon: 'fa-handshake',
    path: '/manager-dashboard/public/reports.html', roles: [ADMIN, MANAGER, ATM], inNav: true },

  { key: 'weekly-review', label: 'Weekly Review', icon: 'fa-file-powerpoint',
    path: '/manager-dashboard/public/weekly-review.html', roles: [ADMIN, MANAGER], inNav: true },

  { key: 'rm-workspace', label: 'RM Workspace', icon: 'fa-user-tie',
    path: '/rm-workspace/public/index.html', roles: [ADMIN, RM], inNav: true },

  { key: 'lead-management', label: 'Lead Management', icon: 'fa-diagram-project',
    path: '/lead-management/public/index.html',
    roles: [ADMIN, MANAGER, ATM, RM, COUNSELOR, BD, CONSULTANT], inNav: true },

  { key: 'consultant-portal', label: 'Consultant Portal', icon: 'fa-handshake-angle',
    path: '/consultant-portal/public/index.html', roles: [ADMIN, CONSULTANT], inNav: true },

  { key: 'lender-pipeline', label: 'Lender Pipeline', icon: 'fa-building-columns',
    path: '/lender-pipeline/public/index.html', roles: [ADMIN, LENDER], inNav: true },

  { key: 'activity-forms', label: 'Activity Forms', icon: 'fa-clipboard-list',
    path: '/admin-dashboard/public/activity-forms.html', roles: [ADMIN, MANAGER], inNav: true },

  { key: 'user-management', label: 'User Management', icon: 'fa-users',
    path: '/authentication/public/users-admin.html', roles: [ADMIN, MANAGER, ATM], inNav: true },
];

const BY_KEY = new Map(DESTINATIONS.map((d) => [d.key, d]));

export function destination(key) {
  return BY_KEY.get(key) ?? null;
}

/** Destinations this role may open, in catalog order. */
export function accessibleDestinations(role) {
  return DESTINATIONS.filter((d) => d.roles.includes(role));
}

/** Destinations to list in the sidebar switcher. */
export function navDestinations(role) {
  return accessibleDestinations(role).filter((d) => d.inNav);
}

export function canAccess(role, key) {
  const d = BY_KEY.get(key);
  // An unknown key is not a silent yes. A page that forgot to register
  // itself should fail loudly in review, not quietly admit everyone.
  return !!d && d.roles.includes(role);
}

/**
 * Where a role lands after signing in, and where guardDestination sends
 * someone who reached a page they may not open. Falls back to the first
 * destination the role can reach, so a new role is never stranded.
 */
export function homePathForRole(role) {
  const HOME = {
    [ADMIN]: 'admin-dashboard',
    [MANAGER]: 'manager-dashboard',
    [ATM]: 'manager-dashboard',
    [RM]: 'rm-workspace',
    [CONSULTANT]: 'consultant-portal',
    [LENDER]: 'lender-pipeline',
    [BD]: 'lead-management',
    [COUNSELOR]: 'lead-management',
  };
  return BY_KEY.get(HOME[role])?.path ?? accessibleDestinations(role)[0]?.path ?? null;
}

/**
 * Page guard. Call at the top of an app's bootstrap, right after the user
 * is known and before anything renders.
 *
 * Returns true when the user may stay. Returns false AND redirects when they
 * may not, so callers should `if (!guardDestination(...)) return;`.
 */
export function guardDestination(user, key, { redirect = true } = {}) {
  const role = user?.role;
  if (role && canAccess(role, key)) return true;

  const home = homePathForRole(role);
  if (!redirect || !home) return false;

  // A role with no home at all would loop forever bouncing between two
  // pages it cannot open; send those to login instead.
  if (window.location.pathname === home) return false;
  window.location.replace(home);
  return false;
}

/**
 * Hide the static sidebar entries a role should not see.
 *
 * Mark up nav items with `data-roles="Admin,Manager"` — comma separated,
 * exact role names. Anything without the attribute is left alone, so this
 * is opt-in and cannot accidentally blank an app's whole sidebar.
 */
export function applyNavPermissions(role, root = document) {
  root.querySelectorAll('[data-roles]').forEach((el) => {
    const allowed = el.dataset.roles.split(',').map((r) => r.trim()).filter(Boolean);
    if (!allowed.includes(role)) el.remove();
  });
}
