// =========================================================
// SHARED UI HELPER — empty-state block markup (icon + title + hint +
// optional call-to-action link). Renders into `.empty-state-block`
// (see shared/css/components.css). Previously reimplemented — with
// drifted signatures — in several app.js files; this is the richest
// existing version (admin-dashboard's), a strict superset of the rest.
// =========================================================
import { escapeHtml } from './utils.js';

/**
 * @param {string} icon Font Awesome icon class suffix, e.g. 'fa-inbox'.
 * @param {string} title
 * @param {string} [hint]
 * @param {{href:string,label:string}} [cta] Optional action link.
 */
export function emptyState(icon, title, hint, cta) {
  return `<div class="empty-state-block"><div class="icon"><i class="fa-solid ${icon}"></i></div><div class="title">${escapeHtml(title)}</div>${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}${cta ? `<a class="btn btn-secondary" href="${cta.href}">${escapeHtml(cta.label)}</a>` : ''}</div>`;
}
