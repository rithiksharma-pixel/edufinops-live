# Testing Plan — Lead Management

## 1. Unit tests (pure logic, no network/DOM)

Target: `js/utils/validation.js`

| Test | Expectation |
|---|---|
| `validateLeadForm` with empty `student_name` | returns `valid: false`, error on `student_name` |
| `validateLeadForm` with a 9-digit phone missing country code but valid length | passes (regex allows 7–15 digits) |
| `validateLeadForm` with malformed email `"abc@"` | returns error on `student_email` |
| `validateLeadForm` with a valid, fully-filled payload | returns `valid: true`, empty error object |
| `validateLeadForm` with `loan_amount_requested = "0"` | returns error (must be > 0) |
| `formatCurrency(150000, 'INR')` | returns `₹1,50,000` (Indian grouping) |
| `isOverdue` with a past ISO date | returns `true` |
| `isOverdue` with `null` | returns `false` (no follow-up set ≠ overdue) |

Recommend: Vitest or plain `node --test`, since these are dependency-free functions — no framework needed to test them.

## 2. RLS policy tests (run directly against Postgres, via `psql` or Supabase's SQL editor)

For each role, seed one test user and confirm:

| Role | Must see | Must NOT see |
|---|---|---|
| Relationship Manager | Leads where `assigned_rm_id = self` | Leads assigned to other RMs |
| Manager | Leads of RMs where `reporting_manager_id = self` | Leads outside their reporting line |
| Consultant | Leads where `source_user_id = self`; **no** `lender_applications` rows at all | Any other consultant's leads; any lender/sanction data |
| Business Development | Same shape as Consultant | Same restrictions as Consultant |
| Admin | Everything | — |

Test method: `set role authenticated; set request.jwt.claim.sub = '<test-user-uuid>';` then run `select * from leads;` and assert row count/identity against expectations. Repeat for `insert`/`update` attempts that should be rejected (expect a policy violation error, not a silent no-op).

Also explicitly test: a Consultant attempting `select * from lender_applications` returns **zero rows**, not an error — RLS should filter, not fail loudly (which would leak existence).

## 2b. RLS policy tests — Deal Stage Flow (verified against real Postgres)

These were run directly, not just written — see the role matrix below with actual results:

| Check | Result |
|---|---|
| RM can select + update `deal_login_details` for their lead's deal | ✅ Passed |
| Counselor can select + update `deal_login_details` for their assigned deal | ✅ Passed |
| Consultant gets **zero rows** on `deal_login_details` | ✅ Passed |
| Consultant gets **zero rows** on `deal_events` | ✅ Passed |
| Consultant gets **zero rows** on `disbursements` | ✅ Passed |
| RM can call `change_deal_stage` then `record_disbursement` back-to-back, both under RLS (not superuser) | ✅ Passed |

Additional RPC lifecycle tests run against a live Postgres instance (see the ERD/schema discussion for detail):

| Scenario | Result |
|---|---|
| `change_deal_stage` moves a deal and auto-creates the destination stage's detail row | ✅ Passed |
| `put_deal_on_hold` → `release_deal_hold` cycle, `is_on_hold` toggles correctly | ✅ Passed |
| `reject_deal` records the stage the deal was at (`rejection_stage_id`), then `reinstate_deal` clears it | ✅ Passed |
| `record_disbursement` across two tranches keeps `total_disbursed_amount` correctly summed | ✅ Passed |
| Every action above lands an immutable row in `deal_events`, in order | ✅ Passed |

## 2c. UI lifecycle tests — Deals tab (verified in a headless browser against the interactive demo)

| Scenario | Result |
|---|---|
| Advance a deal's stage via the drawer, destination stage's fields become editable | ✅ Passed |
| Put a deal on hold, banner shows hold reason; release clears it | ✅ Passed |
| Reject a deal, banner shows rejection reason; reinstate restores the stage-specific view | ✅ Passed |
| Closed Won deal shows all tranches and the correct disbursed total | ✅ Passed |
| "Share with new lender" creates a deal from a lead with none yet | ✅ Passed |

**Known untested surface**: these lifecycle tests ran against the standalone demo's mock data layer, not the production `dealService.js` talking to a live Supabase project — that integration has not been exercised end-to-end.



| Scenario | Expectation |
|---|---|
| Call `change_lead_stage` on a lead the user cannot see | Raises "not found or not visible" (RLS blocks the `for update` select) |
| Call `change_lead_stage` twice concurrently on the same lead (simulate race) | The `for update` lock serializes them; both events land in `lead_events` in the order they committed, no stage is skipped |
| Call `assign_lead` | Old `lead_assignments` row gets `unassigned_at` set; a new row is inserted; a `Reassigned` event appears in `lead_events` |
| `createLead` succeeds but the follow-up event insert fails (simulate by revoking insert on `lead_events` mid-test) | UI surfaces the distinct "timeline entry failed" error rather than reporting a silent success |

## 4. UI / manual QA checklist

- [ ] New Lead form: submitting with empty required fields shows inline errors, does not call the API
- [ ] New Lead form: successful submit closes modal, shows toast, and the new lead appears in the table without a full page reload
- [ ] Filter bar: changing Stage / Source / RM filters re-queries and updates both the table and funnel cards
- [ ] Search box: typing debounces (does not fire a request per keystroke)
- [ ] Clicking a table row opens the drawer with Overview tab active by default
- [ ] Drawer Overview tab: for an RM/Manager/Admin, the stage dropdown is editable and reflects a change immediately; for a Consultant, it's shown as read-only text
- [ ] Drawer Timeline tab: shows most-recent-first, and a stage change performed just now appears at the top after `onLeadUpdated` fires
- [ ] Overdue follow-ups are visually distinguished (red date) in the table
- [ ] Resizing to a mobile viewport (< 860px) collapses the sidebar and the form to a single column without horizontal scroll
- [ ] Keyboard: modal and drawer are dismissible via their close buttons; focus does not get trapped outside either

## 5. Load / scale sanity check (ahead of the "1M leads" design target)

- [ ] `EXPLAIN ANALYZE` the `listLeads` query with `stageId` + `search` filters against a seeded table of 500k+ rows — confirm `idx_leads_current_stage_id` and `idx_leads_student_phone` are actually used (search uses `ilike`, which won't use a plain btree index — flagged in Future Improvements)
- [ ] Confirm `lead_events` timeline queries stay fast at 5M+ rows via `idx_lead_events_lead_id_created_at` (should be an index-only scan for a single lead's timeline)
