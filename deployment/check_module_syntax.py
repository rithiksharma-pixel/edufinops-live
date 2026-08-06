#!/usr/bin/env python3
"""
Parses every browser JS module as an ES MODULE and fails on any syntax error.

Why this exists: `app.js` shipped with both

    import { escapeHtml } from '../../../shared/js/utils.js';
    function escapeHtml(str) { ... }

which is a duplicate declaration and therefore a module-level SyntaxError. The
whole file failed to parse, so NOTHING in it ran -- not bootstrap, and not
guardBootstrap either, since the guard lives in the file that never loaded.
Lead Management sat on "Loading leads..." forever with no error banner and
nothing in the console at load. It looked exactly like a slow query, and cost
a day of chasing database performance that turned out to be unrelated.

`node --check file.js` does NOT catch it. Without a .mjs extension or a
"type": "module" package.json, Node parses the file as CommonJS, where the
import binding is not created and the duplicate is legal. The file has to be
parsed as an ES module to see the error -- which is how the browser loads it,
via <script type="module">.

This feeds the source to `node --input-type=module --check` over stdin, so
files are parsed the same way the browser parses them, with no temp files and
no extension juggling.

Usage:  python deployment/check_module_syntax.py
Exit:   0 = every module parses, 1 = at least one does not
"""
import glob
import subprocess
import sys

PATTERNS = ['*/public/js/**/*.js', 'shared/js/**/*.js']


def module_files():
    seen = []
    for pattern in PATTERNS:
        for path in glob.glob(pattern, recursive=True):
            norm = path.replace('\\', '/')
            if norm not in seen:
                seen.append(norm)
    return sorted(seen)


def check(path):
    """Returns None if the file parses as an ES module, else the error text."""
    with open(path, 'rb') as handle:
        source = handle.read()
    proc = subprocess.run(
        ['node', '--input-type=module', '--check'],
        input=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode == 0:
        return None
    return proc.stderr.decode('utf-8', 'replace').strip()


if __name__ == '__main__':
    failures = []
    files = module_files()
    for path in files:
        err = check(path)
        if err:
            failures.append((path, err))

    if not failures:
        print('OK - all %d modules parse as ES modules.' % len(files))
        sys.exit(0)

    print('Modules that will NOT load in the browser:\n')
    for path, err in failures:
        # Node prints the offending line, a caret, then the error and a stack.
        # The first few lines are the useful part.
        detail = '\n'.join(err.splitlines()[:6])
        print('  %s' % path)
        for line in detail.splitlines():
            print('      %s' % line)
        print()
    print('A module-level SyntaxError means the file never executes at all --')
    print('no bootstrap, and no error banner, because the guard is in the file')
    print('that failed to load. The page just sits on its spinner.')
    sys.exit(1)
