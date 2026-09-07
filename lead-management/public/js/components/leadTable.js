// =========================================================
// PRESENTATION LAYER — Lead table
//
// Column-driven: the header and every row come from the same catalog
// (leadColumns.js), so a column can never appear in one and not the other —
// which is how the header and body drifted out of step before.
//
// Rows open the drawer. Admins and Managers also get a select column and
// per-row actions, so editing or removing a lead does not require opening it
// first.
// =========================================================
import { emptyState } from '../../../../shared/js/emptyState.js';
import { COLUMNS_BY_KEY } from './leadColumns.js';

/**
 * @param {HTMLElement} tbody
 * @param {Array} leads
 * @param {(leadId:string)=>void} onRowClick
 * @param {{columns:string[], canSelect?:boolean, canEdit?:boolean,
 *          canDelete?:boolean, selected?:Set<string>, onToggle?:Function,
 *          onEdit?:Function, onDelete?:Function}} opts
 */
export function renderLeadTable(tbody, leads, onRowClick, opts = {}) {
  const {
    columns = [], canSelect = false, canEdit = false, canDelete = false,
    selected = new Set(), onToggle, onEdit, onDelete,
  } = opts;

  const cols = columns.map((k) => COLUMNS_BY_KEY.get(k)).filter(Boolean);
  const span = cols.length + (canSelect ? 1 : 0) + (canEdit || canDelete ? 1 : 0);

  tbody.innerHTML = '';
  if (!leads || leads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${span || 1}">${emptyState(
      'fa-magnifying-glass', 'No leads match these filters',
      'Try widening your search or clearing a filter to see more results.')}</td></tr>`;
    return;
  }

  for (const lead of leads) {
    const tr = document.createElement('tr');
    tr.dataset.leadId = lead.id;
    if (selected.has(lead.id)) tr.classList.add('row-selected');

    const cells = cols.map((c) => {
      const v = c.get(lead) ?? '';
      if (v === '') return '<td class="lt-blank">–</td>';
      if (c.badge) return `<td><span class="badge badge-accent">${escapeHtml(v)}</span></td>`;
      if (c.key === 'student') return `<td class="lt-primary">${escapeHtml(v)}</td>`;
      return `<td class="${c.numeric ? 'lt-num' : ''}">${escapeHtml(v)}</td>`;
    }).join('');

    tr.innerHTML = `
      ${canSelect ? `<td class="lt-check"><input type="checkbox" data-select
           ${selected.has(lead.id) ? 'checked' : ''} aria-label="Select lead" /></td>` : ''}
      ${cells}
      ${(canEdit || canDelete) ? `<td class="lt-actions">
        ${canEdit ? '<button type="button" class="icon-btn" data-edit title="Edit lead" aria-label="Edit lead"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${canDelete ? '<button type="button" class="icon-btn lt-danger" data-delete title="Delete lead" aria-label="Delete lead"><i class="fa-solid fa-trash"></i></button>' : ''}
      </td>` : ''}`;

    // The checkbox and the action buttons are their own controls — without
    // this, ticking a box would also open the lead.
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-select]') || e.target.closest('[data-edit]')
          || e.target.closest('[data-delete]')) return;
      onRowClick(lead.id);
    });

    const box = tr.querySelector('[data-select]');
    if (box && onToggle) {
      box.addEventListener('change', (e) => {
        e.stopPropagation();
        onToggle(lead.id, box.checked);
        tr.classList.toggle('row-selected', box.checked);
      });
    }
    const editBtn = tr.querySelector('[data-edit]');
    if (editBtn && onEdit) editBtn.addEventListener('click', (e) => { e.stopPropagation(); onEdit(lead.id); });
    const delBtn = tr.querySelector('[data-delete]');
    if (delBtn && onDelete) delBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(lead); });

    tbody.appendChild(tr);
  }
}

/**
 * Build the header row to match. Sortable columns carry data-sort and show
 * the current direction; the rest are plain.
 */
export function renderLeadHeader(headRow, opts = {}) {
  // A missing header must never take the list down with it. This threw on
  // null once already: the selector looked for #leadTable, the markup had
  // only class="lead-table", and the resulting TypeError was swallowed by
  // the load's catch and surfaced as "Could not load leads" — an error that
  // pointed at the query, which was fine.
  if (!headRow) {
    console.warn('renderLeadHeader: no header row found; leaving the existing header in place.');
    return;
  }

  const {
    columns = [], canSelect = false, canEdit = false, canDelete = false,
    sort = {}, onSort, onToggleAll,
  } = opts;

  const cols = columns.map((k) => COLUMNS_BY_KEY.get(k)).filter(Boolean);

  headRow.innerHTML = `
    ${canSelect ? '<th class="lt-check"><input type="checkbox" data-select-all aria-label="Select all on this page" /></th>' : ''}
    ${cols.map((c) => {
      if (!c.sort) return `<th>${escapeHtml(c.label)}</th>`;
      const active = sort.key === c.sort;
      const arrow = active ? (sort.dir === 'asc' ? '↑' : '↓') : '';
      return `<th class="lt-sortable ${active ? 'active' : ''}" data-sort="${c.sort}"
                  title="Sort by ${escapeHtml(c.label)}">${escapeHtml(c.label)}<span class="lt-arrow">${arrow}</span></th>`;
    }).join('')}
    ${(canEdit || canDelete) ? '<th class="lt-actions">Actions</th>' : ''}`;

  if (onSort) {
    headRow.querySelectorAll('[data-sort]').forEach((th) =>
      th.addEventListener('click', () => onSort(th.dataset.sort)));
  }
  const all = headRow.querySelector('[data-select-all]');
  if (all && onToggleAll) all.addEventListener('change', (e) => onToggleAll(e.target.checked));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
