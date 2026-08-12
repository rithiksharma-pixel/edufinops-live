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

The bucket alone isn't enough — Storage has row-level security on `storage.objects` just like every Postgres table, and a private bucket with no policy denies every upload/download with "new row violates row-level security policy". `000_master_migration.sql` already includes the `lead_documents_insert`/`lead_documents_select` policies for this bucket, so as long as you ran Step 2 after this bucket exists, no extra action is needed here.

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
- Document upload is live (Documents tab in the lead detail drawer, RM/Manager/Admin/Counselor only) — see Step 2b for the required Storage bucket + policies.
- Lender-side login doesn't exist — the `bank_rm_id`/`assigned_loan_officer_id` fields on deals are ready for it, but there's no Lender Pipeline app to let a lender actually log in and update their own deals yet.

## Email notifications — REQUIRED SETUP (currently missing)

**Status on the live project: broken.** The database sends the shared
secret correctly, but the Edge Function has no `NOTIFICATION_SECRET` set,
so every send is rejected with 401 and **no notification email has ever
been delivered** — daily digests included. The Edge Function's own
diagnostic confirms it: `expectedSecretPresent: false, providedSecretLength: 72`.

### How the path works

```
Postgres trigger / cron
  └─ notify_via_email(to[], subject, html)          -- reads Vault: notification_secret
       └─ pg_net POST  →  Edge Function send-notification-email
                             -- compares header x-notification-secret
                             -- to env NOTIFICATION_SECRET
                             └─ Gmail SMTP  →  recipient
```

Both sides must hold the **same** value. The Vault side is already set
(72 chars); the Edge Function side is not.

### What to do

1. Read the existing Vault secret (Supabase Dashboard → Project Settings
   → Vault → `notification_secret`), or generate a new one and update
   Vault to match.
2. Set it as an Edge Function secret — **do this yourself; it must not be
   pasted into a chat, a commit, or any file in this repo:**

   ```
   supabase secrets set NOTIFICATION_SECRET=<the value from Vault>
   ```

3. Confirm SMTP is configured too — the same function needs
   `GMAIL_SMTP_USER` and `GMAIL_SMTP_PASSWORD` (a Google **app password**,
   not the account password).
4. Verify:

   ```sql
   select notify_via_email(array['you@yourdomain.com'], 'Test', '<p>hello</p>');
   -- then, a few seconds later:
   select status_code, convert_from(content,'UTF8') from net._http_response order by id desc limit 1;
   ```

   `200` means the whole path works. `401` means the two secrets still
   differ. `500` means the secret matched but SMTP is misconfigured.

### What sends email once it works

| Trigger | Recipient | Notes |
|---|---|---|
| `trg_notify_task_assigned` | the assignee | **instant.** Skipped when you assign a task to yourself |
| `send_daily_digests()` (cron, 02:30 UTC) | every active RM | own scorecard: calls + connect rate, tasks done / open / overdue, milestones, overdue follow-ups, funnel |
| `send_daily_digests()` | Managers & ATMs | per-RM table for their own reports, plus team totals. Skipped if nobody reports to them |
| `send_daily_digests()` | Admins | every RM grouped by team, org totals, plus unassigned-lead count |
| `trg_notify_lead_stage_change` | the lead's RM | **off by default** — the digest covers stage movement. Re-enable via `notification_settings` |
| `trg_notify_deal_stage_change` | the lead's RM | **off by default**, same reason |
| `trg_notify_on_lead_assignment` | the newly assigned RM | pre-existing |
| `trg_notify_on_deal_query` | relevant party | pre-existing |

Manager and Admin figures are computed from the same per-RM temp table
that feeds the RMs' own emails, so a Manager's totals can never disagree
with the sum of their team's individual scorecards.

### Silencing them for a bulk import

The deal-history importer replays historical stage changes, which would
otherwise send one email per row. Turn the flags off first:

```sql
update notification_settings set notify_on_stage_change = false, notify_on_task_assigned = false;
-- run the import, then:
update notification_settings set notify_on_stage_change = true, notify_on_task_assigned = true;
```

---

## BD performance (050)

**Admin Dashboard → Analytics → BD Performance**, and **Manager Dashboard →
Performance → "By BD"** in the grouping dropdown.

Per BD person: channels, active channels, leads, logins, sanctions, PF,
disbursed and disbursed value, over Day / Week / Month / Overall, with CSV.

`bd_performance()` is a deliberate sibling of `rm_performance()` (046) — same
window handling, same column names, same each-metric-against-its-own-date
rule — so a BD row is directly comparable with an owner/team/manager row and
the Manager Dashboard renders both through one table.

### How a BD person is identified

There is no BD foreign key. Attribution is free text, read as-is:

1. `leads.bd_name` if set (per lead, 026), else
2. `consultancies.bd_manager` on the lead's consultancy (012).

Names are matched case- and whitespace-insensitively; real typos stay as
separate rows on purpose, so they are visible and fixable. Only 291 of 12,185
leads carry a `bd_name` but 5,532 have a consultancy, so the fallback takes
coverage from ~2% of the pipeline to ~45%.

Leads that came through a consultancy with no BD owner recorded anywhere land
in an **(Unattributed)** row. That is a data-quality signal, not a person —
fix it by setting `bd_manager` on the consultancy (Admin → Settings).

**Channels** is the roster of consultancies a BD owns and is deliberately not
filtered by the date window. **Active** counts only those that produced a lead
inside it.

`send_bd_performance_report()` was dropped in this revision. Email delivery has
never worked on this project (`NOTIFICATION_SECRET` unset — see above), and the
CSV covers the manual case. Re-add it when notifications actually send.

---

## External portals (052, 053)

Apply **052 before 053**. Findings and evidence: `deployment/PORTAL_AUDIT.md`.

### 052 — apply before giving any external party a login

| Fix | Why |
|---|---|
| `consultancies_select` scoped to internal staff **+ Business Development** | Every lender and consultant login could read all 811 partner names and their BD owners |
| `v_lender_deal_list` | Student name and loan amount rendered blank on every row of the Lender portal |
| `get_deal_messages()` | Lenders saw internal replies with no sender name |
| `documents_insert` + two storage policies opened to source roles | Consultants could not upload a passport or offer letter |
| `get_lead_lender_progress()` | Consultants could not see which bank their student was with |

The BD carve-out matters: `is_internal_staff()` does **not** include Business
Development, and BD users work in Lead Management, which reads `consultancies`
for the New Lead form. Scoping to `is_internal_staff()` alone would break lead
creation for the BD team.

### 053 — reporting for both portals

- **Lender portal → Reports**: milestone counts and amounts for any window, a
  milestone × period matrix at daily / weekly / monthly, and a CSV.
- **Consultant portal → My Report**: students submitted, in progress, sent to a
  bank, logged in, sanctioned, disbursed with values; a stage breakdown; CSV.

Both are scoped by the database. `v_lender_milestones` carries an
`is_lender_side() and belongs_to_lender_org(...)` predicate;
`source_performance()` filters on `source_user_id = auth.uid()` and refuses any
role that is not Consultant / Business Development.

### Two SECURITY DEFINER views, deliberately

`v_lender_deal_list` and `v_lender_milestones` run as their owner rather than
`security_invoker`, unlike every other reporting view here. Not an oversight —
see the note at the top of 052. Short version: a lender has no policy on
`leads` at all, so an invoker view over `leads` returns nothing for them, and
granting one would expose `aadhaar_number`, `pan_number` and internal remarks.
Both carry their authorisation in an explicit `where` clause and are declared
`security_barrier = true`.

**If you edit either view, the `where` clause IS the access control.**

### One decision still open

`get_lead_profile_for_lender()` returns `aadhaar_number`, `pan_number`,
`passport_number` and the address fields to every bank a student is shared
with, including ones that later reject. Plausibly correct for underwriting, so
it was **left unchanged** — but Aadhaar carries handling obligations worth a
deliberate decision. To mask it, drop the column from the `to_jsonb(l)`
projection in that function, or replace it with its last four digits.
