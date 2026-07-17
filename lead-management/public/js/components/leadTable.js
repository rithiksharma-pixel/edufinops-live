// =========================================================
// PRESENTATION LAYER — Lead table
// =========================================================
import { formatCurrency, followUpCell } from '../utils/validation.js';
import { emptyState } from '../../../../shared/js/emptyState.js';

/**
 * Renders lead rows into the given <tbody>.
 * @param {HTMLElement} tbody
 * @param {Array} leads
 * @param {(leadId: string) => void} onRowClick
 */
export function renderLeadTable(tbody, leads, onRowClick) {
  tbody.innerHTML = '';

  if (!leads || leads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyState('fa-magnifying-glass', 'No leads match these filters', 'Try widening your search or clearing a filter to see more results.')}</td></tr>`;
    return;
  }

  for (const lead of leads) {
    const tr = document.createElement('tr');
    tr.dataset.leadId = lead.id;

    const stageName = lead.lead_stages?.name || '–';
    const rmName = lead.assigned_rm?.full_name || 'Unassigned';

    tr.innerHTML = `
      <td>
        <div class="student-name">${escapeHtml(lead.student_name)}</div>
        <div class="student-phone">${escapeHtml(lead.student_phone)}</div>
      </td>
      <td>${escapeHtml(lead.course_name || '–')}${lead.university_name ? ' · ' + escapeHtml(lead.university_name) : ''}</td>
      <td>${formatCurrency(lead.loan_amount_requested, lead.currency)}</td>
      <td><span class="badge badge-accent">${escapeHtml(stageName)}</span></td>
      <td>${escapeHtml(rmName)}</td>
      <td>${followUpCell(lead.next_follow_up_at)}</td>
      <td><i class="fa-solid fa-chevron-right" style="color:var(--ink-300)"></i></td>
    `;

    tr.addEventListener('click', () => onRowClick(lead.id));
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
