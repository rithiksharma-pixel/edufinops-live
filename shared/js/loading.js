// =========================================================
// SHARED UI HELPER — loading placeholder markup, pairs with the
// .spinner / .spinner-block rules in shared/css/components.css.
// Previously most loading states were bare "Loading…" text or nothing.
// =========================================================
import { escapeHtml } from './utils.js';

export function loadingState(message = 'Loading…') {
  return `<div class="spinner-block"><span class="spinner"></span><span>${escapeHtml(message)}</span></div>`;
}
