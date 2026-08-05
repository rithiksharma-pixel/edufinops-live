// =========================================================
// SHARED — "Help & tips" slide-over
//
// The one place a user can go when they don't know something, reachable
// from every portal at the same spot in the top bar. It answers the four
// questions that were previously unanswerable anywhere in the product:
//
//   What am I supposed to do here?   -> role guidance
//   Can you show me?                 -> replay the tour
//   What changed?                    -> what's new
//   Is there a faster way?           -> keyboard shortcuts
//
// Content comes from shared/js/guidance.js. This file is presentation
// only, so adding a role or a changelog entry never means touching it.
// =========================================================

import { escapeHtml } from './utils.js';
import { trapFocus } from './focusTrap.js';
import { openShortcutSheet } from './shortcuts.js';
import { startTour, forgetTour, TOUR_VERSION } from './tour.js';
import { ROLE_GUIDE, DEFAULT_GUIDE, CHANGELOG, TOURS } from './guidance.js';

const SEEN_KEY = 'zt-changelog-seen';

let panelEl = null;
let releaseFocus = null;
let ctx = { appKey: null, appLabel: '', user: null };

// ---------------------------------------------------------
// Unseen-changelog state — drives the dot on the Help button
// ---------------------------------------------------------

function latestChangelogId() {
  return CHANGELOG.length ? CHANGELOG[0].id : null;
}

export function hasUnseenChangelog() {
  const latest = latestChangelogId();
  if (!latest) return false;
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    // Nothing stored means a brand-new browser, not a stale one. Showing
    // a "new" dot to someone on their very first load is noise, so the
    // first read records the current entry and stays quiet.
    if (seen === null) { localStorage.setItem(SEEN_KEY, latest); return false; }
    return seen !== latest;
  } catch {
    return false; // storage disabled — never nag
  }
}

function markChangelogSeen() {
  try { localStorage.setItem(SEEN_KEY, latestChangelogId() ?? ''); } catch { /* storage disabled */ }
}

// ---------------------------------------------------------
// Markup
// ---------------------------------------------------------

function guideFor(role) {
  return ROLE_GUIDE[role] || DEFAULT_GUIDE;
}

function guideHtml(user) {
  const g = guideFor(user?.role);
  return `
    <section class="zt-help-sec">
      <h3>You're signed in as ${escapeHtml(user?.role || 'a user')}</h3>
      <p class="zt-help-lede">${escapeHtml(g.summary)}</p>
      <div class="zt-help-steps-h">Start here</div>
      <ol class="zt-help-steps">
        ${g.firstSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
      </ol>
    </section>`;
}

function tourHtml(appKey, appLabel) {
  if (!TOURS[appKey]) return '';
  return `
    <section class="zt-help-sec">
      <h3>Take the tour</h3>
      <p class="zt-help-lede">A guided walk through ${escapeHtml(appLabel)}, pointing at the real controls. About a minute, and you can leave at any point.</p>
      <button type="button" class="btn btn-primary" id="ztHelpStartTour">
        <i class="fa-solid fa-play"></i> Start the tour
      </button>
    </section>`;
}

function shortcutsHtml() {
  return `
    <section class="zt-help-sec">
      <h3>Keyboard shortcuts</h3>
      <p class="zt-help-lede">Every shortcut available on this page, including the ones this portal adds.</p>
      <button type="button" class="btn btn-secondary" id="ztHelpShortcuts">
        <i class="fa-solid fa-keyboard"></i> Show shortcuts
      </button>
      <span class="zt-help-inline-key">or press <kbd>?</kbd></span>
    </section>`;
}

function changelogHtml() {
  return `
    <section class="zt-help-sec">
      <h3>What's new</h3>
      ${CHANGELOG.map((entry) => `
        <div class="zt-help-log">
          <div class="zt-help-log-head">
            <span class="zt-help-log-title">${escapeHtml(entry.title)}</span>
            <span class="zt-help-log-date">${escapeHtml(entry.date)}</span>
          </div>
          <ul>${entry.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        </div>`).join('')}
    </section>`;
}

// ---------------------------------------------------------
// Open / close
// ---------------------------------------------------------

export function isHelpOpen() {
  return !!panelEl;
}

export function closeHelp() {
  if (!panelEl) return;
  if (releaseFocus) { releaseFocus(); releaseFocus = null; }
  panelEl.remove();
  panelEl = null;
}

export function openHelp() {
  if (panelEl) { closeHelp(); return; }
  const { appKey, appLabel, user } = ctx;

  panelEl = document.createElement('div');
  panelEl.className = 'zt-help-overlay';
  panelEl.innerHTML = `
    <aside class="zt-help" role="dialog" aria-modal="true" aria-labelledby="ztHelpTitle">
      <div class="zt-help-head">
        <div>
          <h2 id="ztHelpTitle">Help &amp; tips</h2>
          <p>${escapeHtml(appLabel || 'Zolve Tangent')}</p>
        </div>
        <button type="button" class="zt-help-close" aria-label="Close help">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="zt-help-body">
        ${guideHtml(user)}
        ${tourHtml(appKey, appLabel)}
        ${shortcutsHtml()}
        ${changelogHtml()}
      </div>
    </aside>`;
  document.body.appendChild(panelEl);

  // Opening the panel is the moment the changelog has been made
  // available, so the dot clears here rather than on scroll-into-view.
  markChangelogSeen();
  document.getElementById('ztHelpBtn')?.classList.remove('has-news');

  panelEl.addEventListener('click', (e) => {
    if (e.target === panelEl || e.target.closest('.zt-help-close')) closeHelp();
  });

  panelEl.querySelector('#ztHelpShortcuts')?.addEventListener('click', () => {
    closeHelp();
    openShortcutSheet();
  });

  panelEl.querySelector('#ztHelpStartTour')?.addEventListener('click', () => {
    closeHelp();
    // Clear the seen-flag first so a replay behaves exactly like a first
    // run, and so leaving it early doesn't leave a half-finished state.
    forgetTour(appKey, TOUR_VERSION);
    startTour({ appKey, version: TOUR_VERSION, steps: TOURS[appKey] });
  });

  releaseFocus = trapFocus(panelEl.querySelector('.zt-help'), { onEscape: closeHelp });
}

/** Called once by appNav when the chrome mounts. */
export function configureHelp({ appKey, appLabel, user }) {
  ctx = { appKey, appLabel, user };
}
