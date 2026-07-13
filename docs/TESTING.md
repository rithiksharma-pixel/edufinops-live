# Testing Plan — Authentication

## Verified against a real Postgres instance (not just written — actually run)

| Test | Result |
|---|---|
| Non-admin calling `invite_user()` | ✅ Correctly raises "Only an Admin can invite users" |
| Admin calling `invite_user()` | ✅ Invitation row created, status `pending` |
| Non-admin selecting from `invitations` | ✅ Returns 0 rows (RLS blocks it entirely) |
| `accept_invitation()` (admin/service-role path) | ✅ Creates `users` row, marks invitation accepted, logs `Activated` event |
| `accept_my_invitation()` (self-service path, JWT email match) | ✅ Same result, callable directly by the invited user with zero elevated privileges |
| `change_user_role()` | ✅ Role updated, `Role Changed` event logged with old/new role |
| `deactivate_user()` → `reactivate_user()` | ✅ `is_active` toggles correctly, both events logged |
| Full audit trail for a user (3 actions) | ✅ All 3 events present, correct order |
| User viewing their own `user_role_events` | ✅ Sees their own rows |
| A different non-admin user viewing someone else's `user_role_events` | ✅ Sees 0 rows |

## Not yet tested (stated plainly)

- The actual login/accept-invite/users-admin **HTML+JS pages** have been syntax-checked only, not run in a browser against a live Supabase project — there's no way to test the real invite-email round trip or a real password-set flow without live credentials and a deployed Edge Function.
- The `send-invite-email` Edge Function itself doesn't exist yet (see README) — the invite RPC will succeed but the actual email step will fail loudly until that function is deployed.

## Manual QA checklist (for whoever deploys this)

- [ ] Invite a user, confirm the email arrives, confirm clicking it lands on `accept-invite.html` with a valid session
- [ ] Set a password shorter than 8 characters — confirm client-side validation blocks it before hitting the RPC
- [ ] Set a password, confirm redirect lands on the correct role's home app
- [ ] Deactivate a user, confirm they're immediately signed out / blocked on next login attempt
- [ ] Change a user's role, confirm they land in a different app on their next login
- [ ] Forgot-password flow: confirm the same reset link correctly branches to "Reset your password" copy (not "Set your password")
