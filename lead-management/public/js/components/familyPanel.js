// =========================================================
// PRESENTATION LAYER — Family & Co-Applicant tab (inside the lead drawer)
// Parents Details (one row per lead) + Co-Applicant Details (extends
// the existing co_applicants row with financial/bank fields).
// =========================================================
import { upsertParentDetails, updateCoApplicant, createCoApplicant } from '../services/leadService.js';

const PARENT_FIELDS = [
  ['father_first_name', 'Father first name', 'text'],
  ['father_last_name', 'Father last name', 'text'],
  ['father_mobile', 'Father mobile number', 'text'],
  ['father_email', 'Father email', 'text'],
  ['mother_first_name', 'Mother first name', 'text'],
  ['mother_last_name', 'Mother last name', 'text'],
  ['mother_mobile', 'Mother mobile number', 'text'],
  ['mother_email', 'Mother email', 'text'],
];

const RELATIONSHIP_OPTIONS = ['Father', 'Mother', 'Guardian', 'Sibling', 'Spouse', 'Other'];
const EMPLOYMENT_OPTIONS = ['Salaried', 'Self-Employed', 'Business', 'Retired', 'Other'];

const CO_APPLICANT_BASE_FIELDS = [
  ['full_name', 'Full name', 'text'],
  ['relationship_to_student', 'Relationship', 'select', RELATIONSHIP_OPTIONS],
  ['phone', 'Phone', 'text'],
  ['email', 'Email', 'text'],
];

const CO_APPLICANT_EXTENDED_FIELDS = [
  ['dob', 'Date of birth', 'date'],
  ['pan_number', 'PAN', 'text'],
  ['aadhaar_number', 'Aadhaar', 'text'],
  ['employment_type', 'Employment status', 'select', EMPLOYMENT_OPTIONS],
  ['employer_name', 'Employer name', 'text'],
  ['designation', 'Designation', 'text'],
  ['monthly_net_income', 'Monthly net income', 'number'],
  ['annual_income', 'Annual income', 'number'],
  ['credit_score', 'Credit score', 'number'],
  ['savings_amount', 'Savings (INR)', 'number'],
  ['has_liabilities', 'Has liabilities', 'checkbox'],
  ['bank_name', 'Bank name', 'text'],
  ['branch_name', 'Branch name', 'text'],
  ['account_number', 'Account number', 'text'],
  ['ifsc_code', 'IFSC code', 'text'],
];

function fieldHtml(key, label, type, value, options) {
  if (type === 'select') {
    const opts = (options || []).map((o) => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
    return `<div class="form-field"><label>${label}</label><select data-field="${key}"><option value="">Select…</option>${opts}</select></div>`;
  }
  if (type === 'checkbox') {
    return `<div class="form-field"><label style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-field="${key}" data-type="checkbox" ${value ? 'checked' : ''} /> ${label}</label></div>`;
  }
  return `<div class="form-field"><label>${label}</label><input type="${type}" data-field="${key}" data-type="${type}" value="${escapeHtml(value ?? '')}" /></div>`;
}

function readForm(container) {
  const fields = {};
  container.querySelectorAll('[data-field]').forEach((el) => {
    if (el.dataset.type === 'checkbox') {
      fields[el.dataset.field] = el.checked;
    } else if (el.dataset.type === 'number') {
      fields[el.dataset.field] = el.value === '' ? null : Number(el.value);
    } else {
      fields[el.dataset.field] = el.value.trim() || null;
    }
  });
  return fields;
}

export async function initFamilyTab(panelEl, lead, parents, coApplicant, ctx) {
  const { currentUser, showToast, onSaved } = ctx;
  const parentData = parents || {};

  const coApplicantHtml = coApplicant
    ? `
      <div class="form-grid">
        ${CO_APPLICANT_BASE_FIELDS.map(([key, label, type, options]) => fieldHtml(key, label, type, coApplicant[key], options)).join('')}
        ${CO_APPLICANT_EXTENDED_FIELDS.map(([key, label, type, options]) => fieldHtml(key, label, type, coApplicant[key], options)).join('')}
      </div>
      <button class="btn btn-primary" id="btnSaveCoApplicant" style="width:100%;justify-content:center;margin-top:10px;">Save co-applicant</button>
    `
    : `
      <p class="empty-state" style="padding:8px 0;">No co-applicant added yet.</p>
      <div class="form-grid">
        ${CO_APPLICANT_BASE_FIELDS.map(([key, label, type, options]) => fieldHtml(key, label, type, '', options)).join('')}
      </div>
      <button class="btn btn-ghost" id="btnAddCoApplicant" style="width:100%;justify-content:center;margin-top:10px;">Add co-applicant</button>
    `;

  panelEl.innerHTML = `
    <h3 style="font-size:14px;font-weight:500;margin:0 0 8px;">Parents details</h3>
    <div class="form-grid" id="parentDetailsForm">${PARENT_FIELDS.map(([key, label, type]) => fieldHtml(key, label, type, parentData[key])).join('')}</div>
    <button class="btn btn-primary" id="btnSaveParentDetails" style="width:100%;justify-content:center;margin-top:10px;">Save parents details</button>

    <h3 style="font-size:14px;font-weight:500;margin:24px 0 8px;">Co-applicant details</h3>
    <div id="coApplicantSection">${coApplicantHtml}</div>
  `;

  document.getElementById('btnSaveParentDetails').addEventListener('click', async () => {
    const fields = readForm(document.getElementById('parentDetailsForm'));
    try {
      await upsertParentDetails(lead.id, fields, currentUser.id);
      showToast('Parents details saved.');
      onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save parents details.', true);
    }
  });

  const coApplicantSection = document.getElementById('coApplicantSection');

  if (coApplicant) {
    document.getElementById('btnSaveCoApplicant').addEventListener('click', async () => {
      const fields = readForm(coApplicantSection);
      if (!fields.full_name || !fields.relationship_to_student) {
        showToast('Full name and relationship are required.', true);
        return;
      }
      try {
        await updateCoApplicant(coApplicant.id, fields);
        showToast('Co-applicant saved.');
        onSaved();
      } catch (err) {
        console.error(err);
        showToast(err.message || 'Could not save co-applicant.', true);
      }
    });
  } else {
    document.getElementById('btnAddCoApplicant').addEventListener('click', async () => {
      const fields = readForm(coApplicantSection);
      if (!fields.full_name || !fields.relationship_to_student) {
        showToast('Full name and relationship are required.', true);
        return;
      }
      try {
        await createCoApplicant(lead.id, fields, currentUser.id);
        showToast('Co-applicant added.');
        onSaved();
      } catch (err) {
        console.error(err);
        showToast(err.message || 'Could not add co-applicant.', true);
      }
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
