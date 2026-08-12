# Lender & Consultant Portal — readiness audit for external accounts

Audited 2026-08-12 against the live "Sales CRM" project (`wgzgqbfankdbqxxcesci`).

> **STATUS — all seven findings addressed.** Findings 1–4, 6 and 7 are fixed
> in `036_external_portal_hardening_migration.sql` plus the portal code
> changes listed against each. Finding 5 is deliberately left as-is pending
> your decision — see it below. Reporting for both portals was added in
> `037_external_portal_reporting_migration.sql`.
>
> **APPLIED to the live project on 2026-08-12** — 034, 036 and 037 are in.
> Re-verified afterwards by impersonation; results in "Verification after the
> fixes" below. 035 (the disbursement-date fix) is still unapplied and
> remains optional.

Every finding below was **verified by impersonating a real account** — running
`set local role authenticated; set local request.jwt.claims = '{"sub":"<user-id>"}'`
inside a rolled-back transaction, which is exactly what RLS sees when that
person signs in. Nothing here is inferred from reading policy text alone.

Accounts used:

| Role | User | Org |
|---|---|---|
| Lender | Test Lender | `f0fc5212…` |
| Lender | Test Bank | `ed1056ab…` (different org, for isolation testing) |
| Consultant | Test Consultant | – |

## Summary

| # | Finding | Severity | Portal | Status |
|---|---|---|---|---|
| 1 | Lenders can read the entire consultancy/BD channel roster | **High** — commercial data leak | Lender | Fixed in 036 |
| 2 | Consultants can read the entire consultancy/BD channel roster | **High** — commercial data leak | Consultant | Fixed in 036 |
| 3 | Every student name and loan amount renders blank in the Lender portal | **High** — app is broken | Lender | Fixed in 036 + `lenderDealService.js` |
| 4 | Lenders cannot resolve any internal staff name | Medium | Lender | Fixed in 036 + `lenderDealService.js` |
| 5 | Aadhaar / PAN / passport shipped to lenders unmasked | Medium — review, may be intended | Lender | **Open — your call** |
| 6 | Consultant portal has no document upload | Medium — functional gap | Consultant | Fixed in 036 + new `documentService.js` |
| 7 | Consultant cannot see lender-stage progress on their own student | Low — by design, worth revisiting | Consultant | Fixed in 036 + new drawer tab |

**What is already correct**, and was confirmed rather than assumed:

- **Cross-org isolation holds.** Test Lender sees 26 deals, Test Bank sees 246
  — no overlap, no leakage between banks.
- **Lenders get zero rows** from `leads`, `co_applicants`,
  `lead_academic_details`, `lead_parent_details`, `documents`, `lead_events`
  and `tasks` by direct query. Student data reaches them only through
  `get_lead_profile_for_lender()`, a `SECURITY DEFINER` RPC that re-checks
  `is_lender_side() AND can_view_deal()` and strips internal pipeline columns.
  That is the right architecture.
- **Consultants see only their own sourced leads** (1 of 12,185) and zero
  deals — `leads_select_source` scopes on `source_user_id = auth.uid()`.

---

## 1 & 2. The BD channel roster is readable by every external account

**This is the most serious finding.** The policy is:

```sql
create policy consultancies_select on consultancies
  for select using (auth.uid() is not null);
```

Any signed-in user, of any role. Measured from a Lender session and again
from a Consultant session, identically:

```
consultancies       811
with_bd_manager     807
distinct_bd_people   25
```

So every bank you onboard, and every consultant, can pull your **complete
partner list — 811 consultancies — plus which of your 25 BD people owns each
relationship.** For a lending-distribution business that roster *is* the
commercial asset. A competing lender with one portal login can enumerate your
entire channel network and who to poach.

Nothing in either portal's UI shows this data; it is reachable by querying
PostgREST directly with the anon key and a portal login, which any browser
devtools session can do.

**Fix** — scope the policy to the roles that actually need the consultancy
picker in the New Lead form. Note that `is_internal_staff()` alone is **not**
the right predicate: it excludes `Business Development`, and BD users are
routed to Lead Management (`roleRoutes.js`), whose
`lookupService.js:162` reads `consultancies` to populate that picker. Using
`is_internal_staff()` on its own would break lead creation for your BD team —
the exact people the channel list is for.

```sql
drop policy if exists consultancies_select on consultancies;
create policy consultancies_select_internal on consultancies
  for select using (
    (select is_internal_staff())            -- Admin/Manager/ATM/RM/Counselor
    or (select auth_role()) = 'Business Development'
  );
```

**Verified safe for the external portals:** `grep` over `consultant-portal/`
and `lender-pipeline/` returns **zero** references to `consultancies` — the
Consultant Add Lead form reads `lead_sources` only. Neither portal loses
anything.

Other internal readers checked and still covered: `admin-dashboard`
(Settings + bulk upsert), `rm-workspace/leadService.js`,
`lead-management/lookupService.js`, and the `exportImportService` importer.

---

## 3. Every student name and loan amount is blank in the Lender portal

`getMyBankDeals()` (`lender-pipeline/.../lenderDealService.js:52`) selects:

```js
.select(`id, is_on_hold, is_rejected, total_disbursed_amount,
         leads ( student_name, loan_amount_requested ), …`)
```

But `leads` has **no SELECT policy for the Lender role** — only
`leads_select_internal_staff`, `leads_select_assignee` and
`leads_select_source`. PostgREST returns the embedded resource as `null`
rather than erroring, so this fails silently. Running the exact query as Test
Lender:

```
id                                    student_name  loan_amount_requested
a0b93768-76c2-467a-8c96-4243ce6ebecc  null          null
d196be97-b89c-4c59-aab5-8fab87098faa  null          null
49345316-6d67-4384-b53c-317bd73e2469  null          null
```

**Effect:** "Our Pipeline" renders `–` in the Student and Requested-amount
columns for all 26 rows. `getDealDetail()` has the same embed, so the deal
drawer header is blank too. A bank logging in sees a list of anonymous rows.

The student data *is* available — `get_lead_profile_for_lender()` returns it
correctly — it just is not used for the list view.

**Fix as built (036):** `v_lender_deal_list` — a narrow view exposing only
the list-view fields (deal id, student name, phone, course, university,
requested amount, stage, status, assigned RM).

One correction to my first instinct, worth recording because it is easy to
get wrong: the view **cannot** be `security_invoker`. An invoker view is
evaluated as the caller, and the caller has no policy on `leads` at all, so
it would return exactly as many rows as the broken embed did — zero. The
view therefore runs as its owner and carries its authorisation explicitly:

```sql
where d.is_deleted = false
  and (select is_lender_side())
  and belongs_to_lender_org(d.lender_id)
```

plus `security_barrier = true`, which stops Postgres pushing a
caller-supplied function below that predicate. `auth.uid()` reads the request
JWT, not the SQL role, so both helpers still identify the real caller inside
an owner-executed view.

**Rejected alternative:** a lender SELECT policy on `leads`. That would hand
lenders every column including Aadhaar and internal remarks, undoing the
point of the curated RPC.

---

## 4. Lenders cannot resolve any internal staff name

From a Lender session:

```
internal users readable  0   (RM / Manager / Admin / Counselor)
users readable total     1   (themselves)
```

`users` has a policy letting internal staff read Lender users, but no reverse.

**Effect:** `getMessages()` selects `sender:users(full_name)`. When your RM
replies on a deal thread, the lender sees the message with no sender name.
There are no `lender_deal_messages` rows yet, so this has not surfaced in
production — it will the first time an RM uses the feature.

**Fix:** a policy letting a lender read the `full_name` of staff attached to a
deal shared with their org, or return the sender name from an RPC.

---

## 5. Aadhaar, PAN and passport go to lenders unmasked

`get_lead_profile_for_lender()` returns `to_jsonb(l)` minus pipeline columns.
It strips `current_stage_id`, `source_user_id`, `consultancy_id` and similar,
but **not** `aadhaar_number`, `pan_number`, `passport_number`, `student_dob`
or the address fields.

For a lender underwriting a loan this is probably intended — they need KYC.
Flagging it as a deliberate decision to confirm rather than a defect, because
Aadhaar in particular carries handling obligations under Indian law, and
right now it goes to every bank a lead is shared with, including ones that
later reject the case. Consider masking to last-4 until the deal reaches
Login, or dropping Aadhaar entirely if the banks collect it themselves.

---

## 6. Consultant portal has no document upload

Consultants submit a student and then cannot attach anything — passport, offer
letter, marksheets. Those have to reach your RM by WhatsApp or email and get
uploaded internally, which is the manual step the portal exists to remove.

The infrastructure is already there: the `lead-documents` bucket, the
`documents` table, and `documentPanel.js` in Lead Management. The Storage
policy is the gate — `000_master_migration.sql` grants insert to internal
staff and Counselors, not source roles.

## 7. Consultant sees no lender progress on their own student

`deals` returns 0 rows for a Consultant, so "Lead status" shows the lead stage
only — not which banks the student was sent to or where each stands. The
README calls this deliberate.

It is the single thing consultants ask for most, and the reason they phone
your RMs. A curated read-only projection (bank name + stage, no amounts, no
internal remarks) mirroring the `get_lead_profile_for_lender()` pattern would
close that loop without exposing anything commercially sensitive.

---

## Storage access, since it came up

Checked during the fix work: `lead_documents_select` on `storage.objects`
already includes `is_lender_side()` gated on `can_view_deal()`, so lenders
can sign URLs for documents on their own cases. That one was fine.


---

## Verification after the fixes

Re-run under impersonation, in a rolled-back transaction, with 036 applied:

| Account | Consultancies readable | Deals in list | Student names populated |
|---|---|---|---|
| Lender — Test Lender | **0** (was 811) | 26 | **26 / 26** (was 0) |
| Lender — Test Bank | **0** (was 811) | 246 | 246 / 246 |
| Consultant | **0** (was 811) | 0 | n/a |
| Business Development | **811** (unchanged — picker still works) | 0 | n/a |

Cross-org isolation re-confirmed: 26 vs 246, one `lender_id` each.

`source_performance()` was also confirmed to refuse a Lender account
outright (`refused: source_performance is for Consultant / Business
Development accounts`) rather than returning empty — a silent empty result
would have looked like "no data" instead of "not for you".

## What is still open

- **Finding 5 (Aadhaar/PAN/passport).** Unchanged on purpose: masking could
  break a bank's KYC workflow, and that is a business call, not a technical
  one. If you want it, the change is a one-line edit to
  `get_lead_profile_for_lender()` — drop the columns from the `to_jsonb(l)`
  projection, or replace Aadhaar with its last 4 digits.
- **Invite / onboarding / password-reset flow** for external users, end to
  end against a real external account.
- **Rate limiting / abuse surface** on the public login endpoint.

---

## Addendum — internal RLS is not scoped the way the runbook claims

Found on 2026-08-12 while regression-testing the 036 rollout. **Not caused by
036/037, not an external-portal issue, and not fixed** — recorded because it
is security-relevant and contradicts the documentation.

`DEPLOYMENT.md` has long stated that "Lead Management's RLS already scopes
their access correctly (RM sees only their leads, Manager sees their team)".
It does not. The governing policy is:

```sql
create policy leads_select_internal_staff on leads
  for select using ((select is_internal_staff()));
```

No team filter, no assignment filter. `is_internal_staff()` covers Admin,
Manager, Associate Team Manager, Relationship Manager and Counselor — so
every one of them can read every lead.

Measured by impersonating a real RM:

| | |
|---|---|
| Leads actually assigned to RM *Sanjeeb Barik* | 937 |
| Leads that RM can read | **12,190** (all of them) |
| Deals that RM can read | **622** (all of them) |
| Leads a Manager can read (`v_master_data`) | **12,277** — identical to an Admin |

The *apps* scope their queries by RM and team, so the UI looks correct. The
database does not enforce it: anyone with a staff login and browser devtools
can read the entire pipeline via PostgREST.

Whether that matters is a business call — a 30-person lending team may
genuinely want open internal visibility. But it should be a decision, not a
surprise, and the runbook currently asserts the opposite.

**Deliberately not fixed here.** Tightening it means rewriting the policy to
use `can_view_lead()` (which already encodes the correct per-role logic) and
then re-testing every internal app — RM Workspace, Manager Dashboard, Admin
Dashboard, Lead Management — because several of them rely on reading rows
outside the current user's own set. That is its own piece of work, not a
side effect of a portal fix.

Note the BD and per-portal reports added in 034/037 inherit whatever this
policy allows: they are `security_invoker`, so if internal visibility is
tightened later, the reports narrow automatically with no code change.
