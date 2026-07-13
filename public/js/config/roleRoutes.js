// =========================================================
// Role -> application routing. This is the one place that encodes
// "which product does each role land in" — update here only.
//
// GO-LIVE STATE (update this comment as apps ship):
// Built and deployed: Authentication, Lead Management (+ Document
// Management, integrated), Consultant Portal, RM Workspace, Manager
// Dashboard, Lender Pipeline.
// Not started: Admin Dashboard (partial — invite/role-mgmt + export/
// import live in Authentication), Reporting, Notification Engine, Settings.
//
// Roles whose dedicated app isn't shipped yet are routed to Lead
// Management, since its RLS already grants them full, correctly-scoped
// access — a working shared surface beats a dead link.
// =========================================================
export const ROLE_HOME_ROUTES = {
  Admin: '/lead-management/public/index.html',              // TODO: swap to /admin-dashboard when it ships
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
