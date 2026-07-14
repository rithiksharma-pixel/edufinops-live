// =========================================================
// PRESENTATION LAYER — Academic Details tab (inside the lead drawer)
// =========================================================
import { upsertAcademicDetails } from '../services/leadService.js';

const FIELDS = [
  ['highest_qualification', 'Highest qualification', 'text'],
  ['english_test_taken', 'English test taken', 'text'],
  ['aptitude_test_taken', 'Aptitude test taken', 'text'],
  ['course_duration_months', 'Course duration (months)', 'number'],
  ['scholarship_offered', 'Scholarship offered', 'checkbox'],
  ['scholarship_amount', 'Scholarship amount (INR)', 'number'],
  ['tenth_score', '10th score', 'text'],
  ['twelfth_score', '12th score', 'text'],
  ['ug_college_name', 'UG college name', 'text'],
  ['ug_course_name', 'UG course name', 'text'],
  ['ug_cgpa', 'UG CGPA', 'text'],
  ['ug_graduation_year', 'UG graduation year', 'number'],
  ['ug_backlogs', 'UG backlogs', 'number'],
  ['pg_college_name', 'PG college name', 'text'],
  ['pg_course_name', 'PG course name', 'text'],
  ['pg_cgpa', 'PG CGPA', 'text'],
];

function fieldHtml(key, label, type, value) {
  if (type === 'checkbox') {
    return `<div class="form-field"><label style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-field="${key}" data-type="checkbox" ${value ? 'checked' : ''} /> ${label}</label></div>`;
  }
  return `<div class="form-field"><label>${label}</label><input type="${type}" data-field="${key}" data-type="${type}" value="${escapeHtml(value ?? '')}" /></div>`;
}

export async function initAcademicDetailsTab(panelEl, lead, academic, ctx) {
  const { currentUser, showToast, onSaved } = ctx;
  const data = academic || {};

  panelEl.innerHTML = `
    <div class="form-grid">${FIELDS.map(([key, label, type]) => fieldHtml(key, label, type, data[key])).join('')}</div>
    <button class="btn btn-primary" id="btnSaveAcademicDetails" style="width:100%;justify-content:center;margin-top:16px;">Save academic details</button>
  `;

  document.getElementById('btnSaveAcademicDetails').addEventListener('click', async () => {
    const fields = {};
    panelEl.querySelectorAll('[data-field]').forEach((el) => {
      if (el.dataset.type === 'checkbox') {
        fields[el.dataset.field] = el.checked;
      } else if (el.dataset.type === 'number') {
        fields[el.dataset.field] = el.value === '' ? null : Number(el.value);
      } else {
        fields[el.dataset.field] = el.value.trim() || null;
      }
    });

    try {
      await upsertAcademicDetails(lead.id, fields, currentUser.id);
      showToast('Academic details saved.');
      onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save academic details.', true);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
