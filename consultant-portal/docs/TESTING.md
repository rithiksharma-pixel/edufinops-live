# Testing Plan — Consultant Portal

## Verified against real Postgres

| Test | Result |
|---|---|
| Lead's own Consultant posts + reads messages | ✅ Passed |
| RM handling the lead reads + replies | ✅ Passed |
| A different, unrelated Consultant reads messages on this lead | ✅ Correctly returns 0 rows |
| That same unrelated Consultant tries to post | ✅ Correctly rejected with an RLS violation error |

## Manual QA checklist

- [ ] Add Lead form validation matches Lead Management's rules (name, phone, amount > 0, source required)
- [ ] Newly added lead appears in "My Students" without a page reload
- [ ] Search box filters by name or phone, debounced
- [ ] Opening a lead shows its real stage history in Lead Status, most-recent handling aside (currently newest-first)
- [ ] Messages tab: sending a message appears immediately without needing to reopen the drawer
- [ ] Profile page: changing name/phone persists; email field is read-only (email changes belong to Authentication, not this app)
