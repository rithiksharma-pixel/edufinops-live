// =========================================================
// PRESENTATION LAYER — Applicant Details tab (inside the lead drawer)
// Personal ID, Loan Identification, Addresses, Alternate Contact,
// Employment, and up to 6 university choices — the EL Details fields
// that live directly on `leads`.
// =========================================================
import { updateApplicantDetails, upsertUniversityChoices } from '../services/leadService.js';

const SELECT_OPTIONS = {
  gender: ['Male', 'Female', 'Other'],
  marital_status: ['Single', 'Married', 'Divorced', 'Widowed'],
  admission_offer_status: ['Not Applied', 'Applied', 'Conditional', 'Finalised', 'Rejected'],
  loan_type: ['Collateral', 'Non Collateral'],
  applicant_financial_status: ['Employed', 'Not Employed', 'Self-Employed', 'Student'],
  employment_status: ['Employed', 'Not Employed', 'Self-Employed', 'Student'],
};

const SECTIONS = [
  {
    title: 'Personal identification',
    fields: [
      ['gender', 'Gender', 'select'],
      ['marital_status', 'Marital status', 'select'],
      ['pan_number', 'PAN number', 'text'],
      ['aadhaar_number', 'Aadhaar number', 'text'],
      ['passport_number', 'Passport number', 'text'],
      ['citizenship', 'Citizenship', 'text'],
    ],
  },
  {
    title: 'Loan identification',
    fields: [
      ['degree', 'Degree', 'text'],
      ['admission_offer_status', 'Admission offer status', 'select'],
      ['loan_type', 'Loan type', 'select'],
      ['applicant_financial_status', 'Applicant financial status', 'select'],
      ['english_test_waived_off', 'English test waived off', 'checkbox'],
      ['aptitude_waived_off', 'Aptitude waived off', 'checkbox'],
      ['have_cosigner', 'Have co-signer', 'checkbox'],
      ['cosigner_relationship', 'Co-signer relationship', 'text'],
      ['coapplicant_financial_status', 'Co-applicant financial status', 'text'],
      ['agricultural_income', 'Agricultural income', 'checkbox'],
      ['total_study_cost', 'Total study cost', 'number'],
      ['parent_alternate_number', 'Parent alternate number', 'text'],
      ['self_funds_available', 'Self funds available', 'number'],
    ],
  },
  {
    title: 'Current address',
    fields: [
      ['current_address', 'Address', 'text'],
      ['current_city', 'City', 'text'],
      ['current_state', 'State', 'text'],
      ['current_country', 'Country', 'text'],
      ['current_pincode', 'Pincode', 'text'],
    ],
  },
  {
    title: 'Permanent address',
    fields: [
      ['permanent_address', 'Address', 'text'],
      ['permanent_city', 'City', 'text'],
      ['permanent_state', 'State', 'text'],
      ['permanent_country', 'Country', 'text'],
      ['permanent_pincode', 'Pincode', 'text'],
    ],
  },
  {
    title: 'Alternate contact',
    fields: [['alternate_phone', 'Alternate phone number', 'text']],
  },
  {
    title: 'Employment (applicant)',
    fields: [
      ['employment_status', 'Employment status', 'select'],
      ['credit_score', 'Credit score', 'number'],
      ['savings_amount', 'Savings (INR)', 'number'],
      ['has_liabilities', 'Has liabilities', 'checkbox'],
      ['liabilities_amount', 'Liabilities amount (INR)', 'number'],
    ],
  },
];

function fieldHtml(key, label, type, value) {
  if (type === 'select') {
    const opts = (SELECT_OPTIONS[key] || [])
      .map((o) => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`)
      .join('');
    return `<div class="form-field"><label>${label}</label><select data-field="${key}"><option value="">Select…</option>${opts}</select></div>`;
  }
  if (type === 'checkbox') {
    return `<div class="form-field"><label style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-field="${key}" data-type="checkbox" ${value ? 'checked' : ''} /> ${label}</label></div>`;
  }
  return `<div class="form-field"><label>${label}</label><input type="${type}" data-field="${key}" data-type="${type}" value="${escapeHtml(value ?? '')}" /></div>`;
}

function universityFieldsHtml(lead, universities) {
  // Choice 1 is the existing university_name column on leads; choices 2-6
  // come from lead_university_choices.
  const rows = [1, 2, 3, 4, 5, 6].map((n) => {
    const value = n === 1 ? lead.university_name : universities.find((u) => u.sequence_order === n)?.university_name;
    return `<div class="form-field"><label>University ${n === 1 ? '(planning to enroll)' : `choice ${n}`}</label><input type="text" data-university="${n}" value="${escapeHtml(value ?? '')}" /></div>`;
  });
  return rows.join('');
}

export async function initApplicantDetailsTab(panelEl, lead, universities, ctx) {
  const { currentUser, showToast, onSaved } = ctx;

  const sectionsHtml = SECTIONS.map(
    (s) => `
    <h3 style="font-size:14px;font-weight:500;margin:20px 0 8px;">${escapeHtml(s.title)}</h3>
    <div class="form-grid">${s.fields.map(([key, label, type]) => fieldHtml(key, label, type, lead[key])).join('')}</div>
  `
  ).join('');

  panelEl.innerHTML = `
    <h3 style="font-size:14px;font-weight:500;margin:0 0 8px;">University choices</h3>
    <div class="form-grid">${universityFieldsHtml(lead, universities)}</div>
    ${sectionsHtml}
    <button class="btn btn-primary" id="btnSaveApplicantDetails" style="width:100%;justify-content:center;margin-top:16px;">Save applicant details</button>
  `;

  document.getElementById('btnSaveApplicantDetails').addEventListener('click', async () => {
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

    const universityChoices = [];
    let universityName1 = '';
    panelEl.querySelectorAll('[data-university]').forEach((el) => {
      const n = Number(el.dataset.university);
      if (n === 1) {
        universityName1 = el.value.trim();
      } else {
        universityChoices.push({ sequence_order: n, university_name: el.value.trim() });
      }
    });
    fields.university_name = universityName1 || null;

    try {
      await updateApplicantDetails(lead.id, fields);
      await upsertUniversityChoices(lead.id, universityChoices, currentUser.id);
      showToast('Applicant details saved.');
      onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save applicant details.', true);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
