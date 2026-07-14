// =========================================================
// PRESENTATION LAYER — Collateral & References tab (inside the lead drawer)
// The UI keeps one collateral entry per lead for simplicity (the schema
// allows more, for future flexibility) plus the two fixed reference slots
// (Applicant, Co-Applicant) the EL Details doc calls for.
// =========================================================
import { upsertCollateralDetails, upsertReference } from '../services/leadService.js';

const COLLATERAL_FIELDS = [
  ['security_offered', 'Security offered', 'checkbox'],
  ['security_type', 'Security type', 'text'],
  ['current_value', 'Current value (INR)', 'number'],
  ['owned_by', 'Owned by', 'text'],
];

const REFERENCE_FIELDS = [
  ['first_name', 'First name', 'text'],
  ['last_name', 'Last name', 'text'],
  ['phone', 'Phone', 'text'],
  ['email', 'Email', 'text'],
  ['address', 'Address', 'text'],
];

function fieldHtml(prefix, key, label, type, value) {
  if (type === 'checkbox') {
    return `<div class="form-field"><label style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-${prefix}-field="${key}" data-type="checkbox" ${value ? 'checked' : ''} /> ${label}</label></div>`;
  }
  return `<div class="form-field"><label>${label}</label><input type="${type}" data-${prefix}-field="${key}" data-type="${type}" value="${escapeHtml(value ?? '')}" /></div>`;
}

function readForm(container, prefix) {
  const fields = {};
  container.querySelectorAll(`[data-${prefix}-field]`).forEach((el) => {
    const key = el.dataset[`${prefix}Field`];
    if (el.dataset.type === 'checkbox') {
      fields[key] = el.checked;
    } else if (el.dataset.type === 'number') {
      fields[key] = el.value === '' ? null : Number(el.value);
    } else {
      fields[key] = el.value.trim() || null;
    }
  });
  return fields;
}

export async function initCollateralReferencesTab(panelEl, lead, collateralRows, references, ctx) {
  const { currentUser, showToast, onSaved } = ctx;
  const collateral = collateralRows?.[0] || {};
  const applicantRef = references.find((r) => r.reference_type === 'Applicant') || {};
  const coApplicantRef = references.find((r) => r.reference_type === 'Co-Applicant') || {};

  panelEl.innerHTML = `
    <h3 style="font-size:14px;font-weight:500;margin:0 0 8px;">Collateral details</h3>
    <div class="form-grid" id="collateralForm">${COLLATERAL_FIELDS.map(([key, label, type]) => fieldHtml('collateral', key, label, type, collateral[key])).join('')}</div>
    <button class="btn btn-primary" id="btnSaveCollateral" style="width:100%;justify-content:center;margin-top:10px;">Save collateral details</button>

    <h3 style="font-size:14px;font-weight:500;margin:24px 0 8px;">Reference (applicant)</h3>
    <div class="form-grid" id="applicantRefForm">${REFERENCE_FIELDS.map(([key, label, type]) => fieldHtml('applicant', key, label, type, applicantRef[key])).join('')}</div>
    <button class="btn btn-primary" id="btnSaveApplicantRef" style="width:100%;justify-content:center;margin-top:10px;">Save applicant reference</button>

    <h3 style="font-size:14px;font-weight:500;margin:24px 0 8px;">Reference (co-applicant)</h3>
    <div class="form-grid" id="coApplicantRefForm">${REFERENCE_FIELDS.map(([key, label, type]) => fieldHtml('coapplicant', key, label, type, coApplicantRef[key])).join('')}</div>
    <button class="btn btn-primary" id="btnSaveCoApplicantRef" style="width:100%;justify-content:center;margin-top:10px;">Save co-applicant reference</button>
  `;

  document.getElementById('btnSaveCollateral').addEventListener('click', async () => {
    const fields = readForm(document.getElementById('collateralForm'), 'collateral');
    try {
      await upsertCollateralDetails(lead.id, collateral.id, fields, currentUser.id);
      showToast('Collateral details saved.');
      onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save collateral details.', true);
    }
  });

  document.getElementById('btnSaveApplicantRef').addEventListener('click', async () => {
    const fields = readForm(document.getElementById('applicantRefForm'), 'applicant');
    try {
      await upsertReference(lead.id, 'Applicant', fields, currentUser.id);
      showToast('Applicant reference saved.');
      onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save applicant reference.', true);
    }
  });

  document.getElementById('btnSaveCoApplicantRef').addEventListener('click', async () => {
    const fields = readForm(document.getElementById('coApplicantRefForm'), 'coapplicant');
    try {
      await upsertReference(lead.id, 'Co-Applicant', fields, currentUser.id);
      showToast('Co-applicant reference saved.');
      onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save co-applicant reference.', true);
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
