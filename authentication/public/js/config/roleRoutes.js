// =========================================================
// Role -> application routing. This is the one place that encodes
// "which product does each role land in" — update here only.
//
// GO-LIVE STATE (update this comment as apps ship):
// Built and deployed: Authentication, Admin Dashboard, Lead Management
// (+ Document Management, integrated), Consultant Portal, RM Workspace,
// Manager Dashboard, Lender Pipeline.
//
// Business Development and Counselor don't have dedicated apps by design
// — they're routed to Lead Management, since its RLS already grants them
// full, correctly-scoped access — a working shared surface beats a dead
// link for roles without enough distinct workflow to justify a bespoke app.
// =========================================================
export const ROLE_HOME_ROUTES = {
  Admin: '/admin-dashboard/public/index.html',
  Manager: '/manager-dashboard/public/index.html',
  'Relationship Manager': '/rm-workspace/public/index.html',
  Consultant: '/consultant-portal/public/index.html',
  'Business Development': '/lead-management/public/index.html', // no dedicated BD app yet
  Counselor: '/lead-management/public/index.html',              // Deals tab is the Counselor's primary surface today
  Lender: '/lender-pipeline/public/index.html',
};

export function getHomeRouteForRole(roleName) {
  return ROLE_HOME_ROUTES[roleName] ?? null;
}
