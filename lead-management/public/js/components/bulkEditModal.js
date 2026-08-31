// =========================================================
// PRESENTATION LAYER — Bulk edit
//
// Set the same fields across every selected lead. Only fields left blank are
// skipped, so "change the BD name on these 40 and leave everything else
// alone" is one action rather than forty.
//
// The field list mirrors the RPC's whitelist (migration 061). The database
// refuses anything outside it by name, so a stale client cannot widen what
// a bulk edit can touch.
// =========================================================
import { updateLeadsBulk, BULK_EDITABLE } from '../services/leadService.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function initBulkEditModal({ showToast, onDone }) {
  let overlay = null;
  let ids = [];

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'bulkEditOverlay';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="bulkEditTitle">',
      '  <div class="modal-header">',
      '    <h2 id="bulkEditTitle">Edit selected leads</h2>',
      '    <button class="icon-btn" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>',
      '  </div>',
      '  <div class="modal-body" id="bulkEditBody"></div>',
      '  <div class="modal-footer" style="padding:14px 22px 18px;margin-top:0;flex:none;">',
      '    <button type="button" class="btn btn-ghost" data-close>Cancel</button>',
      '    <button type="button" class="btn btn-primary" id="btnBulkApply">Apply</button>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.hidden) close();
    });
    overlay.querySelector('#btnBulkApply').addEventListener('click', apply);
    return overlay;
  }

  const close = () => { if (overlay) overlay.hidden = true; };

  function fieldHtml(f) {
    if (f.type === 'select') {
      const opts = f.options.map((o) => {
        const label = f.key === 'intake_month' ? MONTHS[Number(o) - 1] : o;
        return `<option value="${escapeAttr(o)}">${escapeHtml(label)}</option>`;
      }).join('');
      return `<div class="form-field"><label>${escapeHtml(f.label)}</label>
        <select data-field="${f.key}"><option value="">Leave unchanged</option>${opts}</select></div>`;
    }
    return `<div class="form-field"><label>${escapeHtml(f.label)}</label>
      <input type="${f.type}" data-field="${f.key}" placeholder="Leave blank to keep as is" /></div>`;
  }

  function open(leadIds) {
    ensureOverlay();
    ids = [...leadIds];
    overlay.querySelector('#bulkEditBody').innerHTML = `
      <p class="empty-state" style="margin:0 0 14px;text-align:left;">
        Changing <strong>${ids.length}</strong> lead${ids.length === 1 ? '' : 's'}.
        Anything left blank stays as it is.
      </p>
      <div class="form-grid">${BULK_EDITABLE.map(fieldHtml).join('')}</div>`;
    overlay.hidden = false;
  }

  async function apply() {
    const body = overlay.querySelector('#bulkEditBody');
    const btn = overlay.querySelector('#btnBulkApply');
    const patch = {};
    body.querySelectorAll('[data-field]').forEach((el) => {
      const v = el.value.trim();
      if (v === '') return;                       // blank means "leave alone"
      patch[el.dataset.field] = (el.type === 'number' || el.dataset.field === 'intake_month')
        ? Number(v) : v;
    });

    if (Object.keys(patch).length === 0) {
      showToast('Set at least one field, or cancel.', true);
      return;
    }

    btn.disabled = true;
    try {
      const n = await updateLeadsBulk(ids, patch);
      showToast(`Updated ${n} lead${n === 1 ? '' : 's'}.`);
      close();
      onDone();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not apply the changes.', true);
    } finally {
      btn.disabled = false;
    }
  }

  return { open };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
const escapeAttr = escapeHtml;
