// =========================================================
// SHARED — keyboard shortcut registry + the sheet that teaches it
//
// Two problems solved together. The product had no keyboard shortcuts,
// and — more importantly — no way for anyone to discover that fact one
// way or the other. A shortcut nobody knows about is worth nothing, so
// the registry and the "press ? to see them" sheet ship as one unit:
// registering a shortcut is what puts it in the sheet. There is no
// second list to keep in sync.
//
// Shortcuts are single keys, or two-key sequences ("g then 2"). Nothing
// uses Ctrl/Cmd — those belong to the browser, and taking them is how
// you break Ctrl+F for someone. Typing in a field suppresses everything
// except Escape.
// =========================================================

import { escapeHtml } from './utils.js';
import { trapFocus } from './focusTrap.js';

/** @type {Array<{keys:string[],label:string,group:string,run:Function,scope:string,when?:Function}>} */
const registry = [];

let installed = false;
let pendingPrefix = null;
let prefixTimer = null;
let sheetEl = null;
let releaseSheetFocus = null;

const PREFIX_TIMEOUT_MS = 1400;

/** Fields (and rich-text areas) where a bare letter is text, not a command. */
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Register one or more shortcuts.
 *
 * @param {Array<{keys:string[], label:string, group?:string, run:Function, when?:Function}>} list
 * @param {string} [scope='app'] Use 'global' for shortcuts that ship with
 *   the shared chrome; anything else can be cleared with clearScope().
 */
export function registerShortcuts(list, scope = 'app') {
  for (const s of list) {
    registry.push({ group: 'General', scope, ...s });
  }
}

/** Removes every shortcut registered under `scope` (for view teardown). */
export function clearScope(scope) {
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].scope === scope) registry.splice(i, 1);
  }
}

/** Every registered shortcut currently applicable, grouped for display. */
export function getShortcutGroups() {
  const groups = new Map();
  for (const s of registry) {
    if (s.when && !s.when()) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  return groups;
}

/** "g then 2" / "?" — the human form of a key list. */
function keysLabel(keys) {
  return keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('<span class="zt-kbd-then">then</span>');
}

// ---------------------------------------------------------
// The sheet
// ---------------------------------------------------------

export function isShortcutSheetOpen() {
  return !!sheetEl;
}

export function closeShortcutSheet() {
  if (!sheetEl) return;
  if (releaseSheetFocus) { releaseSheetFocus(); releaseSheetFocus = null; }
  sheetEl.remove();
  sheetEl = null;
}

export function openShortcutSheet() {
  if (sheetEl) { closeShortcutSheet(); return; }

  const groups = getShortcutGroups();
  const body = [...groups.entries()].map(([name, items]) => `
    <div class="zt-ks-group">
      <h3>${escapeHtml(name)}</h3>
      ${items.map((s) => `
        <div class="zt-ks-row">
          <span class="zt-ks-label">${escapeHtml(s.label)}</span>
          <span class="zt-ks-keys">${keysLabel(s.keys)}</span>
        </div>`).join('')}
    </div>`).join('');

  sheetEl = document.createElement('div');
  sheetEl.className = 'zt-ks-overlay';
  sheetEl.innerHTML = `
    <div class="zt-ks" role="dialog" aria-modal="true" aria-labelledby="ztKsTitle">
      <div class="zt-ks-head">
        <h2 id="ztKsTitle">Keyboard shortcuts</h2>
        <button type="button" class="zt-ks-close" aria-label="Close shortcuts">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="zt-ks-body">
        ${body || '<p class="zt-ks-empty">No shortcuts are registered on this page.</p>'}
      </div>
      <div class="zt-ks-foot">
        Shortcuts are ignored while you're typing in a field. Press
        <kbd>Esc</kbd> to close.
      </div>
    </div>`;
  document.body.appendChild(sheetEl);

  sheetEl.addEventListener('click', (e) => {
    if (e.target === sheetEl || e.target.closest('.zt-ks-close')) closeShortcutSheet();
  });

  releaseSheetFocus = trapFocus(sheetEl.querySelector('.zt-ks'), {
    onEscape: closeShortcutSheet,
  });
}

// ---------------------------------------------------------
// Dispatch
// ---------------------------------------------------------

/**
 * A half-typed sequence with no feedback is indistinguishable from a
 * keystroke that did nothing, so the pending key is both flagged on
 * <html> (for the CSS that reveals the indicator) and written into any
 * `.zt-seq-hint` element the chrome has rendered.
 */
function paintPrefix(key) {
  const root = document.documentElement;
  if (key) root.setAttribute('data-zt-prefix', key);
  else root.removeAttribute('data-zt-prefix');

  document.querySelectorAll('.zt-seq-hint').forEach((el) => {
    el.textContent = key ? `${key} then…` : '';
  });
}

function clearPrefix() {
  pendingPrefix = null;
  clearTimeout(prefixTimer);
  paintPrefix(null);
}

function setPrefix(key) {
  pendingPrefix = key;
  paintPrefix(key);
  clearTimeout(prefixTimer);
  prefixTimer = setTimeout(clearPrefix, PREFIX_TIMEOUT_MS);
}

function applicable() {
  return registry.filter((s) => !s.when || s.when());
}

function onKeyDown(e) {
  // Browser and OS combinations are never ours to take.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Escape') {
    clearPrefix();
    if (sheetEl) { closeShortcutSheet(); e.preventDefault(); }
    return; // every overlay keeps its own Escape handling
  }

  if (isTypingTarget(e.target)) return;

  // While the sheet is open the only key that matters is Escape (above)
  // — otherwise "?" would toggle it shut and back open on a repeat.
  if (sheetEl) return;

  const key = e.key;
  const list = applicable();

  if (pendingPrefix) {
    const match = list.find((s) => s.keys.length === 2 && s.keys[0] === pendingPrefix && s.keys[1] === key);
    clearPrefix();
    if (match) {
      e.preventDefault();
      match.run();
    }
    return;
  }

  const direct = list.find((s) => s.keys.length === 1 && s.keys[0] === key);
  if (direct) {
    e.preventDefault();
    direct.run();
    return;
  }

  if (list.some((s) => s.keys.length === 2 && s.keys[0] === key)) {
    e.preventDefault();
    setPrefix(key);
  }
}

/** Installs the single global listener. Safe to call more than once. */
export function initShortcuts() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onKeyDown);
}

export { isTypingTarget };
