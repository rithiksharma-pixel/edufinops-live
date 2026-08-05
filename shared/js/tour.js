// =========================================================
// SHARED — first-run guided tour
//
// A spotlight over one real control at a time, with a card explaining
// what it's for. Deliberately not a video, a slideshow, or a wall of
// text: the thing being described stays visible and in place, so the
// tour teaches the actual interface rather than a picture of it.
//
// Three rules this engine enforces, because breaking any of them is how
// product tours become the thing users close without reading:
//
//   1. A step whose target isn't on the page is SKIPPED, not shown
//      pointing at nothing. Role scoping means a Counselor genuinely
//      has no "Assign RM" control, and a tour that insists otherwise
//      is worse than no tour.
//   2. It runs once. Completion (and dismissal — skipping counts) is
//      remembered per app and per tour version, so a returning user is
//      never interrupted twice.
//   3. It is fully keyboard operable and focus-trapped. A modal overlay
//      you can only dismiss with a mouse is an accessibility trap.
// =========================================================

import { escapeHtml } from './utils.js';
import { trapFocus } from './focusTrap.js';

const STORAGE_PREFIX = 'zt-tour-';
const GUTTER = 14;      // gap between the spotlight and the card
const PAD = 8;          // spotlight padding around the target's box

let active = null;      // { steps, index, root, release, cleanup }

// ---------------------------------------------------------
// Seen-state
// ---------------------------------------------------------

function storageKey(appKey, version) {
  return `${STORAGE_PREFIX}${appKey}-v${version}`;
}

export function hasSeenTour(appKey, version) {
  try {
    return localStorage.getItem(storageKey(appKey, version)) !== null;
  } catch {
    // Private mode / storage disabled. Treat as "seen" rather than
    // replaying the tour on every single page load, which would be the
    // more annoying failure of the two.
    return true;
  }
}

function markSeen(appKey, version, how) {
  try { localStorage.setItem(storageKey(appKey, version), how); } catch { /* storage disabled */ }
}

/** Lets the help panel offer "replay the tour" for someone who skipped it. */
export function forgetTour(appKey, version) {
  try { localStorage.removeItem(storageKey(appKey, version)); } catch { /* storage disabled */ }
}

// ---------------------------------------------------------
// Geometry
// ---------------------------------------------------------

function resolveTarget(step) {
  if (!step.target) return null;
  const el = document.querySelector(step.target);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // A zero-size box is a control that exists but isn't laid out (hidden
  // tab panel, `hidden` attribute) — spotlighting it would highlight the
  // top-left corner of the screen.
  if (rect.width === 0 && rect.height === 0) return null;
  return el;
}

/** Steps whose target is actually on the page right now. */
function usableSteps(steps) {
  return steps.filter((s) => !s.target || resolveTarget(s));
}

function placeSpotlight(spotEl, targetEl) {
  if (!targetEl) {
    spotEl.style.display = 'none';
    return null;
  }
  const r = targetEl.getBoundingClientRect();
  spotEl.style.display = 'block';
  spotEl.style.top = `${r.top - PAD}px`;
  spotEl.style.left = `${r.left - PAD}px`;
  spotEl.style.width = `${r.width + PAD * 2}px`;
  spotEl.style.height = `${r.height + PAD * 2}px`;
  return r;
}

function placeCard(cardEl, rect, preferred) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cw = cardEl.offsetWidth;
  const ch = cardEl.offsetHeight;

  if (!rect) { // centred step — no target
    cardEl.style.top = `${Math.max(20, (vh - ch) / 2)}px`;
    cardEl.style.left = `${Math.max(16, (vw - cw) / 2)}px`;
    cardEl.dataset.placement = 'center';
    return;
  }

  const below = vh - rect.bottom;
  const above = rect.top;
  // Honour the requested side only if it actually fits; otherwise flip.
  let placement = preferred === 'top' ? 'top' : 'bottom';
  if (placement === 'bottom' && below < ch + GUTTER && above > below) placement = 'top';
  if (placement === 'top' && above < ch + GUTTER && below > above) placement = 'bottom';

  const top = placement === 'bottom'
    ? rect.bottom + GUTTER + PAD
    : rect.top - ch - GUTTER - PAD;

  // Align to the target's left edge, then clamp inside the viewport so a
  // control near the right edge doesn't push the card off-screen.
  const left = Math.min(Math.max(16, rect.left), vw - cw - 16);

  cardEl.style.top = `${Math.min(Math.max(16, top), vh - ch - 16)}px`;
  cardEl.style.left = `${left}px`;
  cardEl.dataset.placement = placement;
}

// ---------------------------------------------------------
// Render
// ---------------------------------------------------------

function renderStep() {
  if (!active) return;
  const { steps, index, root } = active;
  const step = steps[index];
  const targetEl = resolveTarget(step);

  // Bring the control into view before measuring — a step pointing at
  // something below the fold would otherwise spotlight off-screen.
  if (targetEl) {
    const r = targetEl.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 80) {
      targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  const card = root.querySelector('.zt-tour-card');
  card.querySelector('.zt-tour-step-count').textContent = `${index + 1} of ${steps.length}`;
  card.querySelector('.zt-tour-title').textContent = step.title;
  card.querySelector('.zt-tour-body').textContent = step.body;

  const tip = card.querySelector('.zt-tour-tip');
  tip.hidden = !step.tip;
  if (step.tip) tip.innerHTML = step.tip; // trusted: authored in tourSteps.js

  card.querySelector('.zt-tour-back').disabled = index === 0;
  const next = card.querySelector('.zt-tour-next');
  next.textContent = index === steps.length - 1 ? 'Finish' : 'Next';

  root.querySelector('.zt-tour-dots').innerHTML = steps
    .map((_, i) => `<span class="zt-tour-dot${i === index ? ' on' : ''}"></span>`).join('');

  // Two frames: one for the smooth-scroll to settle, one so the card has
  // been laid out and offsetWidth/Height are real numbers.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rect = placeSpotlight(root.querySelector('.zt-tour-spot'), targetEl);
    placeCard(card, rect, step.placement);
  }));
}

function reposition() {
  if (!active) return;
  const step = active.steps[active.index];
  const rect = placeSpotlight(active.root.querySelector('.zt-tour-spot'), resolveTarget(step));
  placeCard(active.root.querySelector('.zt-tour-card'), rect, step.placement);
}

function go(delta) {
  if (!active) return;
  const next = active.index + delta;
  if (next < 0) return;
  if (next >= active.steps.length) { end('completed'); return; }
  active.index = next;
  renderStep();
}

function end(how) {
  if (!active) return;
  const { appKey, version, release, cleanup, root, onEnd } = active;
  markSeen(appKey, version, how);
  release();
  cleanup();
  root.remove();
  active = null;
  if (onEnd) onEnd(how);
}

// ---------------------------------------------------------
// Public API
// ---------------------------------------------------------

/**
 * Runs a tour. Resolves when it ends (completed or skipped).
 *
 * @param {{appKey:string, version:number, steps:Array, onEnd?:Function}} config
 *   Each step: { target?:string, title:string, body:string, tip?:string,
 *   placement?:'top'|'bottom' }. A step with no `target` is centred.
 * @returns {boolean} false if there was nothing showable.
 */
export function startTour({ appKey, version, steps, onEnd }) {
  if (active) end('interrupted');

  const showable = usableSteps(steps);
  if (showable.length === 0) return false;

  const root = document.createElement('div');
  root.className = 'zt-tour-root';
  root.innerHTML = `
    <div class="zt-tour-spot"></div>
    <div class="zt-tour-card" role="dialog" aria-modal="true" aria-labelledby="ztTourTitle">
      <div class="zt-tour-card-head">
        <span class="zt-tour-step-count"></span>
        <button type="button" class="zt-tour-skip">Skip tour</button>
      </div>
      <h2 class="zt-tour-title" id="ztTourTitle"></h2>
      <p class="zt-tour-body"></p>
      <div class="zt-tour-tip" hidden></div>
      <div class="zt-tour-foot">
        <div class="zt-tour-dots" aria-hidden="true"></div>
        <div class="zt-tour-actions">
          <button type="button" class="btn btn-ghost zt-tour-back">Back</button>
          <button type="button" class="btn btn-primary zt-tour-next">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  root.querySelector('.zt-tour-next').addEventListener('click', () => go(1));
  root.querySelector('.zt-tour-back').addEventListener('click', () => go(-1));
  root.querySelector('.zt-tour-skip').addEventListener('click', () => end('skipped'));

  function onKey(e) {
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }
  // Capture: the shared shortcut dispatcher must not also see these keys.
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  active = {
    appKey, version, steps: showable, index: 0, root, onEnd,
    release: trapFocus(root.querySelector('.zt-tour-card'), {
      initial: root.querySelector('.zt-tour-next'),
      onEscape: () => end('skipped'),
    }),
    cleanup() {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    },
  };

  renderStep();
  return true;
}

/** Runs the tour only if this user hasn't seen (or skipped) it before. */
export function startTourOnce(config) {
  if (hasSeenTour(config.appKey, config.version)) return false;
  return startTour(config);
}

export function isTourActive() {
  return !!active;
}
