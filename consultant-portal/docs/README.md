# Consultant Portal

The Consultant's entire world: **My Students, Add Lead, Lead Status, Messages, Profile** — nothing else, per the brief. This app adds almost no new schema, because Lead Management's existing RLS already scopes `leads`/`lead_events`/`co_applicants` to `source_user_id = auth.uid()` for Consultant/BD roles, and already returns **zero rows** on `deals` for these roles (verified during the Lead Management build).

## What's actually new here

Just one table: **`lead_messages`** — a simple per-lead thread between the Consultant and whoever's handling the lead internally (RM/Manager/Admin). Nothing else needed adding.

## Folder structure

```
consultant-portal/
├── sql/
│   ├── 001_schema.sql       -- lead_messages only
│   └── 002_rls_policies.sql -- cascades from can_view_lead() (Lead Management's helper)
├── public/
│   ├── index.html            -- My Students table + Add Lead modal + drawer (Status/Messages tabs)
│   ├── profile.html
│   ├── css/portal.css
│   └── js/ (config, services: authService/leadService/lookupService/messageService, utils, app.js, profile.js)
└── docs/
```

## Verified

- `lead_messages` RLS tested directly against Postgres: the lead's owning Consultant and the assigned RM can both read/post; a **different, unrelated Consultant gets zero rows and is blocked from posting** (RLS violation thrown, not silently ignored).
- All JS syntax-checked.

## Not tested

- No live-browser run against a real Supabase project (same caveat as every app so far).
- No interactive demo build for this app — see the pacing note given after Authentication shipped.
