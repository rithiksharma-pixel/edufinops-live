// =========================================================
// SHARED — focus trap for overlays
//
// A container that declares `aria-modal="true"` is promising assistive
// technology that focus cannot leave it. Nothing in this codebase
// implemented that promise, so Tab walked straight out into the page
// behind an open drawer and Escape left focus stranded at the top of the
// document with no way back to the row that opened it.
//
// This is the smallest correct implementation: remember the trigger,
// move focus in, cycle Tab within the container, restore focus on
// release. It queries the focusable set on every Tab rather than caching
// it, because every overlay in this product renders its contents
// asynchronously — a cached list would be empty at trap time.
// =========================================================

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE))
    // offsetParent is null for anything display:none — including an
    // ancestor that's hidden, which is how the inactive tab panels here
    // are toggled. Position:fixed elements report null too, so allow those.
    .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
}

/**
 * Traps keyboard focus inside `container` until the returned release
 * function is called.
 *
 * @param {HTMLElement} container
 * @param {{initial?: HTMLElement, onEscape?: () => void}} [opts]
 *   `initial` — element to focus first (defaults to the first focusable,
 *   falling back to the container itself). `onEscape` — called on Escape;
 *   omit to let the key through to the caller's own handler.
 * @returns {() => void} release — restores focus to whatever was focused
 *   when the trap was installed.
 */
export function trapFocus(container, { initial, onEscape } = {}) {
  const previouslyFocused = document.activeElement;

  // A container with no focusable child still has to receive focus, or the
  // screen reader stays parked outside the dialog it just announced.
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');

  const target = initial || focusableWithin(container)[0] || container;
  // Deferred: callers routinely trap in the same tick they unhide the
  // container, and focus() is a no-op on an element that is still hidden.
  requestAnimationFrame(() => target.focus());

  function onKeyDown(e) {
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;

    const items = focusableWithin(container);
    if (items.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    // Focus outside the container (or on the container itself) means the
    // browser is about to hand focus to the page behind — pull it back.
    if (!container.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);

  return function release() {
    document.removeEventListener('keydown', onKeyDown, true);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
}
