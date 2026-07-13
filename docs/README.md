# Authentication

Application #? in the platform (built ahead of order because everything else
depends on real login/role management, which was a stubbed placeholder until now).

Owns: the `users`/`roles` tables' full lifecycle (previously created as
provisional stubs by Lead Management), invitations, and the role/manager
change audit trail. Every other application reads `users`/`roles` but does
not write to them outside the RPC functions defined here.

## Folder structure

```
authentication/
├── sql/
│   ├── 001_schema.sql       -- invitations, user_role_events
│   ├── 002_rls_policies.sql -- admin-only invitations, self/admin/manager-visible audit log
│   └── 003_functions.sql    -- invite, accept, role/manager change, deactivate/reactivate
├── public/
│   ├── login.html / js/login.js
│   ├── forgot-password.html / js/forgot-password.js
│   ├── accept-invite.html / js/accept-invite.js   -- handles BOTH first-time invite and password reset
│   ├── users-admin.html / js/users-admin.js       -- Admin-only: invite, role/manager changes, deactivate
│   ├── css/ (auth.css, users-admin.css)
│   └── js/config/ (supabaseClient.js, roleRoutes.js), js/services/ (authService.js, userAdminService.js)
└── docs/
```

## How the invite flow actually works

1. Admin fills in the Invite form → `invite_user()` RPC records the invitation row (status `pending`).
2. The client then calls a Supabase **Edge Function** (`send-invite-email`, not included here — this needs the `service_role` key, which must never be exposed to the browser) that calls `supabase.auth.admin.inviteUserByEmail()`. That's what actually creates the `auth.users` row and sends the email.
3. The invited person clicks the emailed link, lands on `accept-invite.html` with a temporary Supabase session (but no `users` row yet — so no role, so blocked by every other RLS policy).
4. They set a password (`confirmPasswordReset`), then the page calls `accept_my_invitation()` — a **self-service** function that matches their JWT email against the pending invitation, creates their `users` row, and closes out the invitation. No admin/service-role step needed for this part.
5. They're routed to their role's home application via `roleRoutes.js`.

**Important gap, stated plainly**: the `send-invite-email` Edge Function itself is not part of this deliverable — building and deploying Supabase Edge Functions isn't something this environment can do or test. The RPC and acceptance flow are fully built and verified; the actual email dispatch is a one-function stub you'll need to deploy separately (a few lines using the Supabase Admin SDK).

## Role → application routing

`js/config/roleRoutes.js` is the single source of truth for "which product does this role land in." Roles without a dedicated app yet (Business Development, Counselor, Lender) fall back to Lead Management or show a clear message — update this file as each new application ships.

## What this app deliberately does NOT do

- Does not build the actual Edge Function for sending invite emails (see above).
- Does not implement MFA — explicitly deferred, flagged in Future Improvements.
- Does not let Managers change roles or reporting lines themselves — kept Admin-only for now, since role changes are the most security-sensitive action in the platform.
