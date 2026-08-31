// =========================================================
// PRESENTATION LAYER — Lead table
//
// Rows open the drawer. Admins and Managers also get a select column and
// per-row actions, so editing or removing a lead does not require opening
// it first — which is what "no option to edit or delete from the list"
// meant before this.
// =========================================================
import { formatCurrency, followUpCell } from '../utils/validation.js';
import { emptyState } from '../../../../shared/js/emptyState.js';

const COLS = 7;

/**
 * @param {HTMLElement} tbody
 * @param {Array} leads
 * @param {(leadId:string)=>void} onRowClick
 * @param {{canSelect?:boolean, canEdit?:boolean, canDelete?:boolean,
 *          selected?:Set<string>, onToggle?:Function, onEdit?:Function,
 *          onDelete?:Function}} [opts]
 */
export function renderLeadTable(tbody, leads, onRowClick, opts = {}) {
  const {
    canSelect = false, canEdit = false, canDelete = false,
    selected = new Set(), onToggle, onEdit, onDelete,
  } = opts;
  const extraCols = (canSelect ? 1 : 0) + (canEdit || canDelete ? 1 : 0);

  tbody.innerHTML = '';
  if (!leads || leads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${COLS + extraCols}">${emptyState(
      'fa-magnifying-glass', 'No leads match these filters',
      'Try widening your search or clearing a filter to see more results.')}</td></tr>`;
    return;
  }

  for (const lead of leads) {
    const tr = document.createElement('tr');
    tr.dataset.leadId = lead.id;
    if (selected.has(lead.id)) tr.classList.add('row-selected');

    const stageName = lead.lead_stages?.name || '–';
    const rmName = lead.assigned_rm?.full_name || 'Unassigned';
    // Consultancy comes from the linked record, falling back to the free-text
    // name used when the consultancy wasn't in the list yet ("Other").
    const consultancyName = lead.consultancies?.name || lead.consultancy_other_name;

    tr.innerHTML = `
      ${canSelect ? `<td class="lt-check"><input type="checkbox" data-select
           ${selected.has(lead.id) ? 'checked' : ''} aria-label="Select lead" /></td>` : ''}
      <td>
        <div class="student-name">${escapeHtml(lead.student_name)}</div>
        <div class="student-phone">${escapeHtml(lead.student_phone)}</div>
      </td>
      <td>
        <div>${consultancyName ? escapeHtml(consultancyName) : '<span style="color:var(--ink-300)">–</span>'}</div>
        ${lead.bd_name ? `<div class="student-phone" style="font-family:inherit;">BD: ${escapeHtml(lead.bd_name)}</div>` : ''}
      </td>
      <td>${formatCurrency(lead.loan_amount_requested, lead.currency)}</td>
      <td><span class="badge badge-accent">${escapeHtml(stageName)}</span></td>
      <td>${escapeHtml(rmName)}</td>
      <td>${followUpCell(lead.next_follow_up_at)}</td>
      ${extraCols && (canEdit || canDelete) ? `<td class="lt-actions">
        ${canEdit ? '<button type="button" class="icon-btn" data-edit title="Edit lead" aria-label="Edit lead"><i class="fa-solid fa-pen"></i></button>' : ''}
        ${canDelete ? '<button type="button" class="icon-btn lt-danger" data-delete title="Delete lead" aria-label="Delete lead"><i class="fa-solid fa-trash"></i></button>' : ''}
      </td>` : '<td><i class="fa-solid fa-chevron-right" style="color:var(--ink-300)"></i></td>'}
    `;

    // Row click opens the drawer, but the checkbox and the action buttons are
    // their own controls — without stopPropagation, ticking a box would also
    // open the lead.
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
    if (editBtn && onEdit) {
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); onEdit(lead.id); });
    }
    const delBtn = tr.querySelector('[data-delete]');
    if (delBtn && onDelete) {
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(lead); });
    }

    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
