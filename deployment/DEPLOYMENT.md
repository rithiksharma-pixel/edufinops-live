# Deployment Runbook — Go Live

**Honest framing**: I (Claude) cannot create a Supabase project, deploy Edge Functions, or push to Vercel from this environment — those all require your actual accounts and credentials. Everything below is verified as far as it can be *without* live infrastructure (the SQL was tested end-to-end against a real Postgres instance; the Edge Function code is written but not deployed; the HTML/JS wiring is syntax-checked but never run against a live project). This runbook is what closes that last gap — the steps only you can do.

## What's actually ready to go live

> This table was written at first go-live and had gone stale — it listed
> several shipped apps as "not started". Refreshed 2026-08-12.

| App | Status |
|---|---|
| Authentication | ✅ Full (login, invite, accept-invite, password reset, admin user management) |
| Lead Management | ✅ Full (leads, deals, full Deal Stage Flow, documents) |
| Consultant Portal | ✅ Full (My Students, Add Lead, Bank Progress, Documents, Messages, My Report, Profile) |
| RM Workspace | ✅ Full (dashboard, leads, calls, tasks) |
| Manager Dashboard | ✅ Full (team funnel, milestones, RM + BD performance, TAT, unassigned leads) |
| Admin Dashboard | ✅ Full (overview, documents, reports, insights, team + BD performance, notifications, settings) |
| Lender Pipeline | ✅ Full (dashboard, pipeline, reports, deal management, queries, messages, bank details) |
| Document Management | ✅ Integrated into Lead Management and the Consultant Portal |
| Reporting | ✅ Milestones, stage trends, BD performance, per-portal reports — all with CSV export |
| Notification Engine | ⚠️ Built, but **no email has ever been delivered** — `NOTIFICATION_SECRET` is unset. See below |
| Settings | ✅ Admin Dashboard → Settings |

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

- Every role now lands in its own app — see `roleRoutes.js`. Business Development and Counselor are routed to Lead Management by design, since its RLS already scopes them correctly.
- Document upload is live for RM / Manager / ATM / Admin / Counselor, and for Consultants on their own students once migration 036 is applied. See Step 2b for the required Storage bucket + policies.
- Lender-side login is live (Lender Pipeline). **Do not hand out external logins until migration 036 is applied** — see "External portals" below for what it fixes.
- Disbursements read as zero on the Milestones cards until migration 035 is applied — see below.

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

## BD performance report

Added by `034_bd_performance_migration.sql`. Apply it in the SQL Editor the
same way as every other numbered migration — it is all `CREATE OR REPLACE`,
so re-running is safe.

### Where it shows up

| Surface | Who sees it |
|---|---|
| Admin Dashboard → **BD Performance** (sidebar) | Admins, org-wide |
| Manager Dashboard → **BD performance** section | Managers and ATMs, scoped to their own team |

Both mount the same component (`shared/js/bdPerformancePanel.js`). The numbers
differ only because the RPCs underneath are `security_invoker`, so RLS scopes
them to whoever is signed in — there is no role logic in the client.

### What it measures

Per BD person: **channels · active channels · leads · logins · sanctions ·
PF paid · disbursed · disbursed ₹**, over a chosen date window (7d / 30d /
90d / 1y / Overall / custom), plus a BD × period matrix on any one of those
metrics at **daily, weekly or monthly** granularity.

- **Channels** — consultancies where `consultancies.bd_manager` is that
  person. It is a roster, so it is not affected by the date window.
- **Active** — of those, the ones that produced a lead *inside* the window.
- **Leads** — counted by creation date (IST calendar day).
- **Milestones** — counted on the date recorded against them
  (`login_date`, `sanction_date`, `pf_date`, `disbursed_date`).
- **Disbursed** — deals with at least one tranche in the window, so a
  two-instalment case counts once. The ₹ figure sums every tranche.

### How a BD person is identified

There is no BD foreign key. Attribution is free text, and this report reads it
as-is rather than guessing:

1. `leads.bd_name` if set (captured per lead, migration 026), else
2. `consultancies.bd_manager` on the lead's consultancy (migration 012).

Names are matched case- and whitespace-insensitively; genuine typos stay as
separate rows on purpose, so they are visible and fixable rather than silently
merged. Only 291 of 12,185 leads currently carry a `bd_name`, which is why the
consultancy fallback matters — without it the report would cover ~2% of the
pipeline instead of ~45%.

Leads that came through a consultancy but have no BD name anywhere land in a
**(Unattributed)** row. That row is a data-quality signal: it is real BD
business whose owner was never recorded. Fix it by setting `bd_manager` on the
consultancy (Admin → Settings → Consultancies).

### Downloads

- **Summary CSV** — the leaderboard exactly as displayed.
- **Detail CSV** — the row-level ledger behind it (`v_bd_activity`): one row
  per lead created and per milestone hit, with student, consultancy, lender and
  RM. Both respect RLS, so a Manager exports their team's rows only.

### Automated email — built, NOT scheduled

`send_bd_performance_report(p_from, p_to, p_label)` emails the leaderboard to
every active Admin, Manager and ATM. **Nothing calls it yet** — this was left
manual on purpose. Test it with a single statement:

```sql
-- last 30 days
select send_bd_performance_report(current_date - 30, current_date, 'last 30 days');
-- all time
select send_bd_performance_report();
```

To schedule it, `pg_cron` is already in use on this project (it runs
`send_daily_digests()` at 02:30 UTC). Add whichever cadence you want:

```sql
-- Every Monday 03:00 UTC (08:30 IST) — the previous full week
select cron.schedule('bd-report-weekly', '0 3 * * 1', $$
  select send_bd_performance_report(current_date - 7, current_date - 1, 'last week');
$$);

-- 1st of each month, 03:15 UTC — the previous full month
select cron.schedule('bd-report-monthly', '15 3 1 * *', $$
  select send_bd_performance_report(
    date_trunc('month', current_date - interval '1 month')::date,
    (date_trunc('month', current_date) - interval '1 day')::date,
    to_char(current_date - interval '1 month', 'Mon YYYY'));
$$);
```

Remove one with `select cron.unschedule('bd-report-weekly');`.

> ⚠️ **Delivery still depends on `NOTIFICATION_SECRET`**, which is unset on
> this project — see "Email notifications" above. Until that is fixed the
> scheduled job will run, build the email, and get a 401 from the Edge
> Function. Set the secret first, then schedule.

---

## ⚠ Disbursements are under-reported on the Milestones cards

Found while building the BD report, and **pre-existing** — it is not caused by
anything in `034`.

`record_disbursement()` writes the tranche to `disbursements` and refreshes
`deals.total_disbursed_amount`, but never sets `deals.final_disbursement_date`.
`v_stage_milestones` emits its Disbursement row only
`where d.final_disbursement_date is not null`, so that stream contains **zero**
disbursements regardless of how many happened.

Measured on the live project on 2026-08-12:

| | |
|---|---|
| Deals with tranches in the ledger | 3 (₹1,14,07,774) |
| Deals with `total_disbursed_amount` set | 3 |
| Deals with `final_disbursement_date` set | **0** |
| `v_stage_milestones` Disbursement rows | **0** |

**Affected:** "Milestones by date" on the Manager Dashboard, the same card on
Admin → Reports, and the milestone CSV — all show 0 disbursements.

**Not affected:** the "Disbursed amount" stat cards, which sum
`deals.total_disbursed_amount` directly and were always right. That split is
why it went unnoticed — one number on the page was correct while another was
zero.

**Not affected:** the BD performance report, which reads disbursements from the
`disbursements` ledger (the master migration's own stated source of truth)
rather than the cached column.

`035_disbursement_date_backfill_migration.sql` fixes both halves —
`record_disbursement()` going forward, plus a one-time backfill. It is
**optional and separate** because applying it changes numbers on cards outside
the BD feature (they go from 0 to the true figure; nothing decreases, and no
lead, deal or ledger row is modified). Apply it when you are ready for the
Milestones cards to start showing real disbursement counts.

### Two data-quality issues also worth a look

Neither is a code bug; both showed up while validating against live data on
2026-08-12. Three rows in total:

- **2 logins** out of range: one `login_date` is **`0067-05-31`** — almost
  certainly a mistyped year — and one is `2026-08-13`, tomorrow. The `0067` row
  pulls the "Overall" window back by two millennia on any date-bounded chart.
- **1 sanction** dated **2026-08-30**, in the future. Probable sanction dates
  may be getting entered in the actual-date field.
- PF dates are clean.

Find them with:

```sql
select 'login' as kind, deal_id, login_date as dt from deal_login_details
where is_deleted = false and (login_date < '2020-01-01' or login_date > current_date)
union all
select 'sanction', deal_id, sanction_date from deal_sanction_details
where is_deleted = false and (sanction_date < '2020-01-01' or sanction_date > current_date)
union all
select 'pf', deal_id, pf_date from deal_pf_details
where is_deleted = false and (pf_date < '2020-01-01' or pf_date > current_date)
order by dt;
```

---

## External portals — hardening, gaps and reporting

`036_external_portal_hardening_migration.sql` and
`037_external_portal_reporting_migration.sql`. Apply **036 before 037**; 037
reuses the access pattern 036 establishes.

Full findings and evidence: `deployment/PORTAL_AUDIT.md`.

### 036 — apply this before giving any external party a login

| Fix | Why |
|---|---|
| `consultancies_select` scoped to internal staff **+ Business Development** | Every lender and consultant login could read all 811 partner names and their BD owners |
| `v_lender_deal_list` | Student name and loan amount rendered blank on every row of the Lender portal |
| `get_deal_messages()` RPC | Lenders saw internal replies with no sender name |
| `documents_insert` + two storage policies opened to source roles | Consultants could not upload a passport or offer letter |
| `get_lead_lender_progress()` RPC | Consultants could not see which bank their student was with |

The BD carve-out matters: `is_internal_staff()` does **not** include
Business Development, and BD users work in Lead Management, which reads
`consultancies` for the New Lead form. Scoping to `is_internal_staff()`
alone would break lead creation for the BD team.

### 037 — reporting for both portals

- **Lender portal → Reports** (new sidebar item): milestone counts and
  amounts for any window, a milestone × period matrix at daily / weekly /
  monthly, and a CSV of the underlying rows.
- **Consultant portal → My Report** (new page): students submitted, in
  progress, sent to a bank, logged in, sanctioned, disbursed with values;
  a stage breakdown; and a CSV of their own students.

Both are scoped by the database, not the client. `v_lender_milestones`
carries an `is_lender_side() and belongs_to_lender_org(...)` predicate;
`source_performance()` filters on `source_user_id = auth.uid()` and refuses
any role that is not Consultant / Business Development.

### Two SECURITY DEFINER views, deliberately

`v_lender_deal_list` and `v_lender_milestones` run as their owner rather
than `security_invoker`, which is the opposite of every other reporting view
in this project. That is not an oversight — see the long note at the top of
036. Short version: a lender has no policy on `leads` at all, so an invoker
view over `leads` returns nothing for them, and the alternative (granting
lenders a `leads` policy) would expose `aadhaar_number`, `pan_number` and
internal remarks. Both views instead carry their authorisation in an
explicit `where` clause and are declared `security_barrier = true`.

**If you edit either view, the `where` clause IS the access control.**

### Verified after applying (impersonation, rolled back)

| Account | Consultancies | Deals listed | Student names |
|---|---|---|---|
| Lender — Test Lender | 0 (was 811) | 26 | 26 / 26 (was 0) |
| Lender — Test Bank | 0 (was 811) | 246 | 246 / 246 |
| Consultant | 0 (was 811) | – | – |
| Business Development | 811 (unchanged) | – | – |

Cross-org isolation re-confirmed. `source_performance()` refuses a Lender
account outright rather than returning an empty result.

### One decision still open

`get_lead_profile_for_lender()` returns `aadhaar_number`, `pan_number`,
`passport_number` and the address fields to every bank a student is shared
with, including ones that later reject the case. That is plausibly correct
for underwriting, so it was **left unchanged** — but Aadhaar carries
handling obligations worth a deliberate decision rather than a default. To
mask it, drop the column from the `to_jsonb(l)` projection in that function,
or replace it with its last four digits.
