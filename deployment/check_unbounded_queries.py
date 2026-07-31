#!/usr/bin/env python3
"""
Flags Supabase reads that can be silently truncated by PostgREST's
1000-row cap.

Why this exists: the Admin Dashboard reported "1000 Active leads" against a
1,450-lead pipeline, and the Lead Management funnel summed to 1000 while the
tab beside it correctly said 1448. Nothing errors when this happens -- the
query just stops at 1000 rows and every count derived from it is quietly
wrong, which is far harder to notice than a crash.

A read is considered SAFE when it:
  - bounds itself with .range() or .limit()
  - is a header count (head: true) -- never subject to the cap
  - returns one row (.single() / .maybeSingle())
  - is wrapped in fetchAll() (shared/js/fetchAll.js), which pages until done
  - hits a fixed-size lookup table (see SAFE_TABLES)

Anything else on a table that can grow past 1000 rows gets reported.

Usage:  python deployment/check_unbounded_queries.py
Exit:   0 = clean, 1 = findings (so it can gate a deploy)
"""
import glob
import re
import sys

# Config/lookup tables bounded by business setup, not by customer volume.
SAFE_TABLES = {
    'roles', 'teams', 'lead_stages', 'lead_sources', 'deal_stages',
    'deal_stage_statuses', 'deal_hold_reasons', 'deal_rejection_reasons',
    'lead_lost_reasons', 'lead_lender_not_shared_reasons', 'document_types',
    'deal_query_categories', 'lenders', 'lender_branches', 'announcements',
}

# Reads already reviewed and confirmed bounded by a filter -- e.g. a query
# on the 24k-row lead_lender_status table that is scoped .eq('lead_id', ...)
# and so returns ~17 rows. "file:table" -- keep this list short and justified.
REVIEWED_SAFE = {
    'lead-management/public/js/services/lenderStatusService.js:lead_lender_status',  # .eq('lead_id')
    'lead-management/public/js/services/leadService.js:lead_events',                 # timeline, .eq('lead_id')
    'consultant-portal/public/js/services/leadService.js:lead_events',               # timeline, .eq('lead_id')
    'lead-management/public/js/services/leadService.js:co_applicants',               # .eq('lead_id')
    'lead-management/public/js/services/leadService.js:lead_collateral_details',     # .eq('lead_id')
    'lead-management/public/js/services/leadService.js:lead_references',             # .eq('lead_id')
    'lead-management/public/js/services/leadService.js:deals',                       # .eq('lead_id')
    'lead-management/public/js/services/documentService.js:documents',               # .eq('lead_id')
    'lead-management/public/js/services/dealService.js:deal_events',                 # .eq('deal_id')
    'lead-management/public/js/services/dealService.js:disbursements',               # .eq('deal_id')
    'lead-management/public/js/services/dealQueryService.js:deal_queries',           # .eq('deal_id')
    'lender-pipeline/public/js/services/dealQueryService.js:deal_queries',           # .eq('deal_id')
    'lender-pipeline/public/js/services/lenderDealService.js:disbursements',         # .eq('deal_id')
    'lender-pipeline/public/js/services/lenderDealService.js:lender_deal_messages',  # .eq('deal_id')
    'consultant-portal/public/js/services/messageService.js:lead_messages',          # .eq('lead_id')
    'lead-management/public/js/services/savedViewsService.js:saved_views',           # per-user, tiny
    'lead-management/public/js/services/dealService.js:deals',                       # .eq('lead_id')
    'lead-management/public/js/services/lenderStatusService.js:v_deal_tat',          # .eq('lead_id')
}

BOUNDED_MARKERS = ('.range(', '.limit(', 'head: true', 'head:true',
                   '.single()', '.maybeSingle()')


def scan():
    findings = []
    for path in sorted(glob.glob('**/public/js/**/*.js', recursive=True)):
        src = open(path, encoding='utf-8', errors='ignore').read()
        norm = path.replace('\\', '/')
        for m in re.finditer(r"\.from\(\s*['\"](\w+)['\"]\s*\)", src):
            table = m.group(1)
            if table in SAFE_TABLES:
                continue
            if '%s:%s' % (norm, table) in REVIEWED_SAFE:
                continue
            chunk = src[m.end():m.end() + 800]
            cut = chunk.find(';')
            chain = chunk[:cut] if cut > 0 else chunk
            if '.select(' not in chain:
                continue  # a write
            if any(mark in chain for mark in BOUNDED_MARKERS):
                continue
            preceding = src[max(0, m.start() - 400):m.start()]
            if any(w in preceding for w in ('fetchAll(', 'fetchAllResult(', 'fetchAllRows(')):
                continue
            findings.append((norm, src[:m.start()].count('\n') + 1, table))
    return findings


if __name__ == '__main__':
    found = scan()
    if not found:
        print('OK - no unbounded reads on growth tables.')
        sys.exit(0)
    print('Unbounded reads that PostgREST will truncate at 1000 rows:\n')
    for path, line, table in found:
        print('  %s:%d  ->  %s' % (path, line, table))
    print('\nFix: wrap in fetchAll() from shared/js/fetchAll.js, add .range()/.limit(),')
    print('or -- if a filter already bounds it -- add it to REVIEWED_SAFE with the reason.')
    sys.exit(1)
