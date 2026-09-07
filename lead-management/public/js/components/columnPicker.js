// =========================================================
// PRESENTATION LAYER — Column picker
//
// Tick the columns you want on the leads list. Grouped, because a flat list
// of twenty checkboxes is its own kind of unusable, and someone being
// trained should be able to find "Login date" under Milestones rather than
// scanning the lot.
// =========================================================
import { LEAD_COLUMNS, COLUMNS_BY_KEY, DEFAULT_COLUMNS, resetColumns } from './leadColumns.js';

const GROUPS = [
  { title: 'Who', keys: ['student', 'phone', 'email'] },
  { title: 'Where it is', keys: ['stage', 'priority', 'follow_up', 'last_activity'] },
  { title: 'Milestones', keys: ['created', 'login_date', 'sanction_date', 'pf_date', 'disbursed_date'] },
  { title: 'Ownership', keys: ['rm', 'source', 'consultancy', 'bd'] },
  { title: 'Application', keys: ['amount', 'intake', 'country', 'course', 'university'] },
];

export function initColumnPicker({ getColumns, onApply }) {
  let overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'columnPickerOverlay';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="colPickTitle">',
      '  <div class="modal-header">',
      '    <h2 id="colPickTitle">Choose columns</h2>',
      '    <button class="icon-btn" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>',
      '  </div>',
      '  <div class="modal-body" id="colPickBody"></div>',
      '  <div class="modal-footer" style="padding:14px 22px 18px;margin-top:0;flex:none;justify-content:space-between;">',
      '    <button type="button" class="btn btn-ghost" id="colPickReset">Reset to default</button>',
      '    <span>',
      '      <button type="button" class="btn btn-ghost" data-close>Cancel</button>',
      '      <button type="button" class="btn btn-primary" id="colPickApply">Apply</button>',
      '    </span>',
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
    overlay.querySelector('#colPickApply').addEventListener('click', apply);
    overlay.querySelector('#colPickReset').addEventListener('click', () => {
      onApply(resetColumns());
      close();
    });
    return overlay;
  }

  const close = () => { if (overlay) overlay.hidden = true; };

  function open() {
    ensureOverlay();
    const chosen = new Set(getColumns());
    overlay.querySelector('#colPickBody').innerHTML = `
      <p class="empty-state" style="margin:0 0 14px;text-align:left;">
        Your choice is remembered on this browser. It does not change what
        anyone else sees.
      </p>
      ${GROUPS.map((g) => `
        <h4 class="cp-group">${escapeHtml(g.title)}</h4>
        <div class="cp-grid">
          ${g.keys.map((k) => {
            const c = COLUMNS_BY_KEY.get(k);
            if (!c) return '';
            return `<label class="cp-item ${c.always ? 'locked' : ''}">
              <input type="checkbox" value="${k}" ${chosen.has(k) ? 'checked' : ''}
                     ${c.always ? 'disabled checked' : ''} />
              ${escapeHtml(c.label)}${c.always ? ' <span class="cp-lock">always</span>' : ''}
            </label>`;
          }).join('')}
        </div>`).join('')}`;
    overlay.hidden = false;
  }

  function apply() {
    const body = overlay.querySelector('#colPickBody');
    const picked = [...body.querySelectorAll('input:checked')].map((i) => i.value);
    // Keep catalog order rather than click order, so the table reads the same
    // way for everyone regardless of the order boxes were ticked.
    const ordered = LEAD_COLUMNS.map((c) => c.key).filter((k) => picked.includes(k));
    onApply(ordered.length ? ordered : [...DEFAULT_COLUMNS]);
    close();
  }

  return { open };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
