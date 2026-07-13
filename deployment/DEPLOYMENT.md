# Deployment Runbook — Go Live

**Honest framing**: I (Claude) cannot create a Supabase project, deploy Edge Functions, or push to Vercel from this environment — those all require your actual accounts and credentials. Everything below is verified as far as it can be *without* live infrastructure (the SQL was tested end-to-end against a real Postgres instance; the Edge Function code is written but not deployed; the HTML/JS wiring is syntax-checked but never run against a live project). This runbook is what closes that last gap — the steps only you can do.

## What's actually ready to go live

| App | Status |
|---|---|
| Authentication | ✅ Full (login, invite, accept-invite, password reset, admin user management) |
| Lead Management | ✅ Full (leads, deals, full Deal Stage Flow) |
| Consultant Portal | ✅ Full (My Students, Add Lead, Lead Status, Messages, Profile) |
| RM Workspace | ⚠️ Database schema only — no UI yet. Routed to Lead Management in the meantime (see `roleRoutes.js`) |
| Manager Dashboard, Admin Dashboard, Lender Pipeline, Document Management, Reporting, Notification Engine, Settings | ❌ Not started |

## Step 1 — Create the Supabase project

1. Go to [supabase.com](https://supabase.com), create a new project, note the **Project URL** and **anon public key** (Settings → API).
2. Also note the **service_role key** on that same page — this one is dangerous, treat it like a root password. It's needed once, in Step 4, and nowhere else.

## Step 2 — Run the database migration

1. Open the SQL Editor in your Supabase dashboard.
2. Paste in the entire contents of `deployment/000_master_migration.sql` and run it.
3. This was tested end-to-end against a real Postgres instance in this exact form — it should run without errors. If it doesn't, the error message will tell you which `-- SOURCE:` section it failed in.

## Step 2b — Create the document storage bucket

The Document Management feature (Documents tab in Lead Management) uploads real files to Supabase Storage, not just Postgres rows. In Supabase Dashboard → Storage → "New bucket":
- Name: `lead-documents` (must match exactly — `documentService.js` hardcodes this)
- Public: **No** (keep it private; the app uses signed URLs for downloads, never public links)

## Step 3 — Create your first Admin (chicken-and-egg problem)

Every other user gets created via the Admin's "Invite user" flow — but the first Admin has no one to invite them. Do this once, manually:

1. In Supabase Dashboard → Authentication → Users → "Add user", create a user with your own email and a password directly.
2. Copy that user's UUID.
3. In the SQL Editor, run:
   ```sql
   insert into users (id, role_id, full_name, email)
   select '<paste-the-uuid-here>', id, 'Your Name', 'your@email.com'
   from roles where name = 'Admin';
   ```
4. You can now log in at `/authentication/public/login.html` and use "Manage Users" to invite everyone else properly.

## Step 4 — Deploy the invite-email Edge Function

This is the one privileged piece — it's the only place the `service_role` key is ever used.

1. Install the Supabase CLI if you haven't: `npm install -g supabase`
2. From the `authentication/` folder: `supabase functions deploy send-invite-email`
3. Set the required secrets (never put these in any browser-facing file):
   ```
   supabase secrets set SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<the service_role key from Step 1>
   supabase secrets set SITE_URL=https://your-deployed-domain.com
   ```

## Step 5 — Configure Supabase Auth settings

In Supabase Dashboard → Authentication → URL Configuration:
- **Site URL**: your deployed domain (e.g. `https://yourcompany.vercel.app`)
- **Redirect URLs**: add `https://your-domain.com/authentication/public/accept-invite.html`

This is what makes the invite and password-reset emails land the user on the right page with a valid session.

## Step 6 — Fill in real credentials for the browser-facing apps

1. Copy `shared/env.js.example` to `shared/env.js`.
2. Fill in your real `SUPABASE_URL` and the **anon** key (never the service_role key) from Step 1.
3. Add `shared/env.js` to `.gitignore` before committing anything — every deployment environment (staging, production) should have its own copy with the right values, never checked into source control.

## Step 7 — Deploy to Vercel

1. Push this whole repository to GitHub (or connect it directly).
2. In Vercel, "Add New Project" → import the repo → framework preset: **Other** (no build step, it's static files).
3. The included `deployment/vercel.json` (copy it to the repo root) redirects `/` to the login page; every other file is served at its literal path since these are plain static apps.
4. Deploy. Visit the root URL — it should redirect to login.

## Step 8 — Smoke test before telling real users to log in

- [ ] Log in as the Admin created in Step 3
- [ ] Invite a test Consultant, confirm the email arrives (this is the step most likely to reveal a misconfiguration — check Supabase's Auth logs if it doesn't)
- [ ] Accept that invite, set a password, confirm it lands on Consultant Portal
- [ ] As the Consultant, add a test lead
- [ ] Log in as Admin again, confirm that lead appears in Lead Management with the Consultant correctly attributed as the source

## Known limitations to communicate to whoever's using this

- RMs, Managers, and Admins currently all land in Lead Management after login — RM Workspace, Manager Dashboard, and Admin Dashboard don't have dedicated UIs yet. Lead Management's RLS already scopes their access correctly (RM sees only their leads, Manager sees their team), so this is safe, just not purpose-built for those roles yet.
- No document upload/storage exists yet (Document Management app not started) — "Documents Requested/Received" are timeline events only, no actual file attaches to them.
- Lender-side login doesn't exist — the `bank_rm_id`/`assigned_loan_officer_id` fields on deals are ready for it, but there's no Lender Pipeline app to let a lender actually log in and update their own deals yet.
