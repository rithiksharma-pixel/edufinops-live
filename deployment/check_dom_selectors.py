"""
Find DOM lookups that can never resolve.

For each HTML page: follow its entry module through the whole import graph,
collect every id / class the JS reaches for, and check it against BOTH the
page's static markup AND anything the JS itself injects at runtime. Report
only lookups that exist in neither — those are the ones that hand you a null
and, if unguarded, a TypeError.
"""
import os, re, io, glob, json
from collections import defaultdict

ROOT = '.'


def read(p):
    return io.open(p, encoding='utf-8', errors='replace').read()


def resolve_imports(entry, seen=None):
    """Every module a page pulls in, transitively."""
    if seen is None:
        seen = set()
    entry = os.path.normpath(entry)
    if entry in seen or not os.path.exists(entry):
        return seen
    seen.add(entry)
    src = read(entry)
    for m in re.finditer(r"(?:from|import)\s+'(\.[^']+)'", src):
        resolve_imports(os.path.join(os.path.dirname(entry), m.group(1)), seen)
    return seen


# ---------- what each page statically contains ----------
pages = {}
for p in glob.glob('*/public/**/*.html', recursive=True):
    p = p.replace(os.sep, '/')
    html = read(p)
    entries = [os.path.join(os.path.dirname(p), m)
               for m in re.findall(r'<script[^>]+type="module"[^>]+src="([^"]+)"', html)]
    pages[p] = {
        'ids': set(re.findall(r'\sid="([^"]+)"', html)),
        'classes': set(c for grp in re.findall(r'\sclass="([^"]+)"', html) for c in grp.split()),
        'modules': set().union(*[resolve_imports(e) for e in entries]) if entries else set(),
    }

# ---------- what each module looks up, and what it injects ----------
mod_lookups = defaultdict(set)   # module -> {('id'|'sel', value, line)}
mod_creates = defaultdict(set)   # module -> ids/classes it writes into the DOM

for j in glob.glob('*/public/**/*.js', recursive=True) + glob.glob('shared/js/*.js'):
    j = os.path.normpath(j)
    src = read(j)

    for i, line in enumerate(src.splitlines(), 1):
        for m in re.finditer(r"getElementById\(\s*'([^']+)'", line):
            mod_lookups[j].add(('id', m.group(1), i))
        for m in re.finditer(r"querySelector(?:All)?\(\s*'([^']+)'", line):
            sel = m.group(1)
            # Only static selectors are checkable; anything built from a
            # variable is resolved at runtime and out of scope here.
            if '${' in sel:
                continue
            mod_lookups[j].add(('sel', sel, i))

    # Ids and classes the module itself renders — these are legitimately
    # absent from the page's static markup.
    mod_creates[j] |= set(re.findall(r'\sid="([^"]+)"', src))
    mod_creates[j] |= set(re.findall(r"\.id\s*=\s*'([^']+)'", src))
    for grp in re.findall(r'\sclass="([^"]+)"', src):
        mod_creates[j] |= set(c for c in grp.split() if '${' not in c)
    for grp in re.findall(r"className\s*=\s*'([^']+)'", src):
        mod_creates[j] |= set(grp.split())


def parts(sel):
    """The ids and classes a simple selector depends on."""
    return (set(re.findall(r'#([A-Za-z0-9_-]+)', sel)),
            set(re.findall(r'\.([A-Za-z0-9_-]+)', sel)))


# ---------- cross-check ----------
findings = []
for page, info in pages.items():
    if not info['modules']:
        continue
    created_ids, created_cls = set(), set()
    for mod in info['modules']:
        created_ids |= mod_creates[mod]
        created_cls |= mod_creates[mod]

    for mod in sorted(info['modules']):
        for kind, val, line in sorted(mod_lookups[mod]):
            if kind == 'id':
                if val not in info['ids'] and val not in created_ids:
                    findings.append((page, mod, line, f'#{val}', 'id never exists'))
            else:
                ids, cls = parts(val)
                missing_ids = [i for i in ids if i not in info['ids'] and i not in created_ids]
                missing_cls = [c for c in cls if c not in info['classes'] and c not in created_cls]
                if missing_ids or missing_cls:
                    what = ', '.join([f'#{i}' for i in missing_ids] + [f'.{c}' for c in missing_cls])
                    findings.append((page, mod, line, val, f'missing {what}'))

by_mod = defaultdict(list)
for page, mod, line, sel, why in findings:
    by_mod[(mod, sel, why)].append(page)

print(f'{len(pages)} pages, {sum(len(v["modules"]) for v in pages.values())} page-module pairs')
print(f'{len(by_mod)} distinct unresolvable lookups\n')
for (mod, sel, why), pgs in sorted(by_mod.items()):
    short = [os.path.basename(os.path.dirname(os.path.dirname(p))) for p in pgs]
    print(f'{mod}')
    print(f'   {sel}   -> {why}')
    print(f'   on: {", ".join(sorted(set(short)))}\n')
