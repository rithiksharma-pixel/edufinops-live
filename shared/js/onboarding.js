// =========================================================
// SHARED — onboarding bootstrap
//
// One call from appNav wires up everything a first-time (or returning)
// user needs: the global shortcuts, the help panel's context, and the
// first-run tour. Apps do not call any of this directly — mounting the
// shared top bar is what turns it on, so a new portal gets onboarding
// for free the moment it renders the chrome.
//
// The only genuinely fiddly part is WHEN to start the tour. mountTopbar
// runs early in bootstrap, long before the funnel cards, tables and
// panels a tour wants to point at exist. Starting immediately would skip
// most steps as "not present"; a fixed delay would either be too short on
// a slow connection or waste time on a fast one. So we wait for the page
// to stop changing: poll for how many of the tour's targets have
// resolved, and start once that number holds steady (or we hit the
// ceiling). See scheduleTour below.
// =========================================================

import { registerShortcuts, initShortcuts, openShortcutSheet, clearScope } from './shortcuts.js';
import { configureHelp, openHelp, hasUnseenChangelog } from './helpPanel.js';
import { startTourOnce, isTourActive, TOUR_VERSION } from './tour.js';
import { TOURS } from './guidance.js';

const TOUR_POLL_MS = 350;
const TOUR_MAX_POLLS = 12;   // ~4s ceiling before we start with what we have

let started = false;

/** The page's primary search box, whatever each app happens to call it. */
function findSearchInput() {
  return document.querySelector('[data-zt-search]')
    || document.getElementById('filterSearch')
    || document.getElementById('searchInput')
    || document.querySelector('input[type="search"]');
}

function resolvedTargetCount(steps) {
  let n = 0;
  for (const s of steps) {
    if (!s.target) { n++; continue; }
    const el = document.querySelector(s.target);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) n++;
  }
  return n;
}

function scheduleTour(appKey) {
  const steps = TOURS[appKey];
  if (!steps) return;

  let polls = 0;
  let lastCount = -1;
  let stableFor = 0;

  const tick = () => {
    if (isTourActive()) return;               // help panel replayed it first
    const count = resolvedTargetCount(steps);
    stableFor = count === lastCount ? stableFor + 1 : 0;
    lastCount = count;
    polls++;

    // Two identical readings means the page has settled. Requiring at
    // least one resolved target stops us declaring "settled" against a
    // page that simply hasn't rendered anything yet.
    const settled = stableFor >= 1 && count > 0;
    if (settled || polls >= TOUR_MAX_POLLS) {
      startTourOnce({ appKey, version: TOUR_VERSION, steps });
      return;
    }
    setTimeout(tick, TOUR_POLL_MS);
  };

  setTimeout(tick, TOUR_POLL_MS);
}

/**
 * @param {{appKey:string, appLabel:string, user:object,
 *          apps:Array<{key:string,label:string,path:string}>,
 *          onToggleTheme:Function}} opts
 */
export function initOnboarding({ appKey, appLabel, user, apps, onToggleTheme }) {
  configureHelp({ appKey, appLabel, user });

  // Re-mounting the chrome (mountTopbar is called again on some role
  // changes) must not register a second copy of every global shortcut.
  clearScope('global');

  registerShortcuts([
    { keys: ['?'], label: 'Show keyboard shortcuts', group: 'Getting around', run: openShortcutSheet },
    { keys: ['h'], label: 'Open Help & tips', group: 'Getting around', run: openHelp },
    {
      keys: ['/'],
      label: 'Jump to search',
      group: 'Getting around',
      when: () => !!findSearchInput(),
      run: () => { const el = findSearchInput(); if (el) { el.focus(); el.select?.(); } },
    },
    { keys: ['t'], label: 'Switch light / dark theme', group: 'Getting around', run: onToggleTheme },
  ], 'global');

  // One "g then N" per portal this role can actually open. The same
  // numbers are printed in the switcher menu, so the shortcut teaches
  // itself the first time someone opens it looking for another app.
  if (apps.length > 1) {
    registerShortcuts(
      apps.slice(0, 9).map((a, i) => ({
        keys: ['g', String(i + 1)],
        label: `Go to ${a.label}`,
        group: 'Switch portal',
        run: () => { window.location.href = a.path; },
      })),
      'global'
    );
  }

  initShortcuts();

  // Guard against mountTopbar being called more than once per page —
  // the tour should be scheduled exactly once.
  if (started) return;
  started = true;
  scheduleTour(appKey);
}

/**
 * Attaches the help button's behaviour. Separate from initOnboarding
 * because the top bar re-renders its own markup on every breadcrumb
 * change, which destroys the previous button and its listener.
 */
export function wireHelpButton() {
  const helpBtn = document.getElementById('ztHelpBtn');
  if (!helpBtn) return;
  helpBtn.addEventListener('click', openHelp);
  if (hasUnseenChangelog()) helpBtn.classList.add('has-news');
}

export { registerShortcuts, clearScope };
