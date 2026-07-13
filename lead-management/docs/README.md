# Lead Management

Application #2 of the Loan Operations Platform. Owns the core lead entity,
its pipeline stages, co-applicants, lender-application fan-out, and the
permanent event timeline. Every other application (RM Workspace, Consultant
Portal, Manager Dashboard, Lender Pipeline, Reporting) reads from the tables
this application owns — it does not own any of *their* UI.

## Folder structure

```
lead-management/
├── sql/
│   ├── 001_schema.sql          -- all tables, indexes, audit triggers (leads + deals model)
│   ├── 002_rls_policies.sql    -- row-level security, one policy set per role
│   ├── 003_seed_data.sql       -- roles, lead stages/sources, deal stages/statuses, reason lookups
│   └── 004_functions.sql       -- atomic RPCs: lead stage/assignment, deal stage/hold/reject/disbursement
├── public/
│   ├── index.html
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── config/
│       │   └── supabaseClient.js      -- ONLY file that imports the Supabase SDK
│       ├── services/                   -- business logic / data access layer
│       │   ├── authService.js
│       │   ├── lookupService.js       -- stages, sources, deal lookups, lenders, counselors, loan officers
│       │   ├── leadService.js         -- lead CRUD, stage/assignment
│       │   └── dealService.js         -- deal CRUD, stage-specific detail tables, hold/reject/disbursement
│       ├── components/                 -- presentation layer, pure render + wire
│       │   ├── funnelCards.js
│       │   ├── leadTable.js
│       │   ├── leadFormModal.js
│       │   ├── leadDrawer.js          -- Overview / Deals / Timeline tabs
│       │   └── dealPanel.js           -- per-deal stage pipeline, forms, hold/reject/tranche actions
│       ├── utils/
│       │   └── validation.js           -- pure functions, unit-testable in isolation
│       └── app.js                      -- entry point, wires everything together
└── docs/
    ├── README.md            (this file)
    └── TESTING.md
```

## The Deal Stage Flow (Lender-level model)

A **Deal** (table: `deals`) is one lead shared with one lender. It's distinct from the Lead's own `lead_stages` — a single lead can have several deals in flight with different lenders, each at a different stage.

- **Stages** (`deal_stages`, configurable): Bank Prospect → Login → Sanction → PF → Disbursement → Closed Won.
- **Stage-specific fields** live in their own child tables (`deal_bank_prospect_details`, `deal_login_details`, `deal_sanction_details`, `deal_pf_details`) rather than one wide table — each stage genuinely captures different data.
- **On Hold** and **Rejected** are overlay flags on the deal (`is_on_hold`, `is_rejected`), not stage values — they can happen from any stage, matching the business's own "Any Stage" framing. Rejecting a deal records which stage it was at via `rejection_stage_id`.
- **Roles introduced by this model**: `Counselor` (internal sales team, assigned per deal) and `Lender` (future login — the bank's own RM and loan officer are modeled as `users` with this role so their access is ready before that application exists).
- **Every stage transition, hold, release, rejection, reinstatement, and disbursement is atomic** via a Postgres function (`sql/004_functions.sql`) and always writes an immutable row to `deal_events` — the timeline can never drift from the deal's actual state, even under concurrent edits.

## Layering rules this app follows

1. **Components never import each other.** They only import services and utils. `app.js` is the only file that wires components together.
2. **Only `supabaseClient.js` imports `@supabase/supabase-js`.** If we ever swap backends, only that one file changes.
3. **Nothing hardcodes a lead stage name in JS.** Stages are fetched from `lead_stages` at runtime — an Admin can add a new stage without a code deploy.
4. **The timeline is never written to directly from the client for stage/assignment changes.** `change_lead_stage` and `assign_lead` are Postgres functions (`sql/004_functions.sql`) so the lead's state and its event log can never drift apart, even under concurrent edits.
5. **RLS is the real security boundary.** Anything the UI hides (e.g. the "New lead" button for a Lender role) is a UX nicety, not a security control — the database policies in `002_rls_policies.sql` are what actually stop a user from reading or writing data outside their role.

## Setup

1. Run `sql/001_schema.sql`, then `002`, `003`, `004` in order against your Supabase project (SQL Editor or `psql`).
2. In `public/js/config/supabaseClient.js`, replace the placeholder URL/key, or inject them via `window.__ENV__` at build time (Vercel environment variables) — never commit real keys.
3. Serve `public/` as a static site (Vercel, or any static server locally). No build step required — plain ES modules load directly in the browser.
4. This app assumes the Authentication app has already created rows in `users`/`roles` for whoever logs in. Until that app exists, insert a test user manually:
   ```sql
   insert into roles (name) values ('Admin') on conflict do nothing;
   insert into users (id, role_id, full_name, email)
   values ('<an auth.users id>', (select id from roles where name = 'Admin'), 'Test Admin', 'admin@example.com');
   ```

## What this app deliberately does NOT do

- Does not manage login/signup UI — that's the Authentication app.
- Does not manage document upload/storage — that's the Document Management app (events like "Documents Requested" are logged here, but no file lives here).
- Does not compute team-wide reports/dashboards — that's Manager Dashboard / Reporting, which will query these same tables read-only.
- Does not auto-derive the Lead's own stage from the highest active Deal stage across lenders — this was explicitly descoped during the Deal Stage Flow revision and remains a follow-up.

## Known gaps (verified as gaps, not just flagged)

- `deal_bank_prospect_details.bank_rm_id` (the lender's own RM) has no UI control yet to set it.
- No database trigger enforces that `assigned_loan_officer_id` / `bank_rm_id` actually reference a `users` row with role `Lender` — currently convention only.
- The production JS files have been syntax-checked and mirror logic verified in the standalone demo, but have never run against a live Supabase project (no credentials available in this environment) — the demo proves the logic, not the wiring to a real database.
