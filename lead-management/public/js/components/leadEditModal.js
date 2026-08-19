// =========================================================
// PRESENTATION LAYER — Edit lead modal
//
// Migration 051 gave Admin and Manager permission to edit a lead, but there
// was no form anywhere in the app that wrote the lead's own columns, so the
// permission was unreachable. This is that form.
//
// It covers the fields captured at intake plus the milestone dates. The
// deeper EL fields (addresses, employment, co-signer …) already have their
// own home in the Applicant Details tab and are not duplicated here.
//
// Two rules the form shows, and the database enforces for real:
//   - Lead stage is Admin-only (set_lead_stage re-checks the role).
//   - Disbursed amount/date appear once the stage is Disbursement, or
//     whenever a figure has already been recorded.
// =========================================================
import { updateLead, setLeadStage, getLeadDetail } from '../services/leadService.js';
import { getLeadSources, getLeadStages, getConsultancies } from '../services/lookupService.js';

const OTHER_CONSULTANCY_VALUE = '__other__';
const DISBURSED_STAGE = 'Disbursement';

const SELECT_OPTIONS = {
  gender: ['Male', 'Female', 'Other'],
  marital_status: ['Single', 'Married', 'Divorced', 'Widowed'],
  priority: ['Urgent', 'High', 'Normal', 'Low'],
  loan_type: ['Collateral', 'Non Collateral'],
  admission_offer_status: ['Not Applied', 'Applied', 'Conditional', 'Finalised', 'Rejected'],
  employment_status: ['Employed', 'Not Employed', 'Self-Employed', 'Student'],
  currency: ['INR', 'USD', 'GBP', 'EUR', 'CAD', 'AUD'],
};

const SECTIONS = [
  {
    title: 'Student',
    fields: [
      ['student_name', 'Student name', 'text'],
      ['student_phone', 'Phone', 'tel'],
      ['alternate_phone', 'Alternate phone', 'tel'],
      ['student_email', 'Email', 'email'],
      ['student_dob', 'Date of birth', 'date'],
      ['parent_alternate_number', 'Parent contact', 'tel'],
      ['gender', 'Gender', 'select'],
      ['marital_status', 'Marital status', 'select'],
    ],
  },
  {
    title: 'Course',
    fields: [
      ['course_name', 'Course', 'text'],
      ['university_name', 'University', 'text'],
      ['destination_country', 'Destination country', 'text'],
      ['degree', 'Degree', 'text'],
      ['intake_month', 'Intake month (1-12)', 'number'],
      ['intake_year', 'Intake year', 'number'],
      ['admission_offer_status', 'Admission offer status', 'select'],
    ],
  },
  {
    title: 'Loan',
    fields: [
      ['loan_amount_requested', 'Loan amount requested', 'number'],
      ['currency', 'Currency', 'select'],
      ['loan_type', 'Loan type', 'select'],
      ['total_study_cost', 'Total study cost', 'number'],
      ['self_funds_available', 'Self funds available', 'number'],
      ['savings_amount', 'Savings', 'number'],
      ['credit_score', 'Credit score', 'number'],
      ['employment_status', 'Employment status', 'select'],
    ],
  },
];

// Each milestone carries a "month only" companion flag (migration 052) for
// imported rows where only the month was known. Those are counted in
// reporting but excluded from TAT, so the flag has to survive an edit rather
// than being silently cleared.
const MILESTONES = [
  ['login_date', 'Login date', 'login_date_month_only'],
  ['sanction_date', 'Sanction date', 'sanction_date_month_only'],
  ['pf_date', 'PF date', 'pf_date_month_only'],
];

export function initLeadEditModal({ showToast, currentUser, onLeadUpdated }) {
  let overlay = null;
  let sources = [];
  let stages = [];
  let consultancies = [];
  let lead = null;

  const isAdmin = currentUser.role === 'Admin';

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'leadEditOverlay';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="leadEditTitle">',
      '  <div class="modal-header">',
      '    <h2 id="leadEditTitle">Edit lead</h2>',
      '    <button class="icon-btn" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>',
      '  </div>',
      '  <div class="modal-body" id="leadEditBody"></div>',
      // The shared .modal-footer assumes it sits INSIDE .modal-body and so
      // inherits its horizontal padding. This form is long enough that the
      // buttons should stay put while the fields scroll, which means the
      // footer is a sibling instead — and has to supply that padding itself.
      '  <div class="modal-footer" style="padding:14px 22px 18px;margin-top:0;flex:none;">',
      '    <button type="button" class="btn btn-ghost" data-close>Cancel</button>',
      '    <button type="button" class="btn btn-primary" id="btnSaveLeadEdit">Save changes</button>',
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
    overlay.querySelector('#btnSaveLeadEdit').addEventListener('click', save);
    return overlay;
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  function fieldHtml(key, label, type, value) {
    if (type === 'select') {
      const opts = (SELECT_OPTIONS[key] || [])
        .map((o) => `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`)
        .join('');
      return `<div class="form-field"><label>${escapeHtml(label)}</label>`
        + `<select data-field="${key}"><option value="">Select…</option>${opts}</select></div>`;
    }
    // Every editable column here is a date or scalar, never a timestamp, so
    // the stored value already fits the input's expected format.
    return `<div class="form-field"><label>${escapeHtml(label)}</label>`
      + `<input type="${type}" data-field="${key}" data-type="${type}" value="${escapeHtml(value ?? '')}" /></div>`;
  }

  function milestoneHtml() {
    const rows = MILESTONES.map(([key, label, flagKey]) => [
      '<div class="form-field">',
      `  <label>${escapeHtml(label)}</label>`,
      `  <input type="date" data-field="${key}" data-type="date" value="${escapeHtml(lead[key] ?? '')}" />`,
      '  <label style="flex-direction:row;align-items:center;gap:6px;font-weight:400;font-size:12px;margin-top:6px;">',
      `    <input type="checkbox" data-field="${flagKey}" data-type="checkbox" ${lead[flagKey] ? 'checked' : ''} />`,
      '    Month known, exact day is not',
      '  </label>',
      '</div>',
    ].join('\n')).join('');

    // The stage gates the disbursement pair, but it stays visible once a
    // figure exists so an earlier entry can still be corrected.
    const showDisbursed = lead.lead_stages?.name === DISBURSED_STAGE
      || lead.disbursed_date != null
      || lead.disbursed_amount != null;
    const hide = showDisbursed ? '' : 'hidden';

    const disbursed = [
      `<div class="form-field" data-disbursed-field ${hide}>`,
      '  <label>Disbursed date</label>',
      `  <input type="date" data-field="disbursed_date" data-type="date" value="${escapeHtml(lead.disbursed_date ?? '')}" />`,
      '</div>',
      `<div class="form-field" data-disbursed-field ${hide}>`,
      '  <label>Disbursed amount</label>',
      `  <input type="number" min="0" step="1000" data-field="disbursed_amount" data-type="number" value="${escapeHtml(lead.disbursed_amount ?? '')}" />`,
      '</div>',
    ].join('\n');

    return rows + disbursed;
  }

  function sourceHtml() {
    const sourceOpts = sources
      .map((s) => `<option value="${s.id}" ${s.id === lead.lead_source_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
      .join('');
    const consOpts = consultancies
      .map((c) => `<option value="${c.id}" ${c.id === lead.consultancy_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
    const isOther = !lead.consultancy_id && !!lead.consultancy_other_name;
    const priorityOpts = SELECT_OPTIONS.priority
      .map((p) => `<option value="${p}" ${lead.priority === p ? 'selected' : ''}>${p}</option>`)
      .join('');

    return [
      '<div class="form-field">',
      '  <label>Lead source</label>',
      `  <select data-field="lead_source_id" id="editSourceSelect">${sourceOpts}</select>`,
      '</div>',
      '<div class="form-field" id="editConsultancyField">',
      '  <label>Consultancy</label>',
      '  <select data-field="consultancy_id" id="editConsultancySelect">',
      '    <option value="">Not set</option>',
      `    ${consOpts}`,
      `    <option value="${OTHER_CONSULTANCY_VALUE}" ${isOther ? 'selected' : ''}>Other — type a name</option>`,
      '  </select>',
      `  <input type="text" id="editConsultancyOther" data-field="consultancy_other_name" data-type="text"`,
      `         placeholder="Consultancy name" value="${escapeHtml(lead.consultancy_other_name ?? '')}" ${isOther ? '' : 'hidden'} />`,
      '</div>',
      '<div class="form-field">',
      '  <label>BD name</label>',
      `  <input type="text" data-field="bd_name" data-type="text" value="${escapeHtml(lead.bd_name ?? '')}" />`,
      '</div>',
      '<div class="form-field">',
      '  <label>Priority</label>',
      `  <select data-field="priority"><option value="">Select…</option>${priorityOpts}</select>`,
      '</div>',
    ].join('\n');
  }

  function stageHtml() {
    if (!isAdmin) {
      return '<p class="empty-state" style="margin:0;">Stage is set automatically from activity. '
        + 'Only an Admin can override it.</p>';
    }
    // Lead Lost is excluded: it needs a reason, which the Mark as Lost flow
    // captures. set_lead_stage rejects it too.
    const opts = stages
      .filter((s) => s.name !== 'Lead Lost')
      .map((s) => `<option value="${s.id}" ${s.id === lead.current_stage_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
      .join('');
    return [
      '<div class="form-grid">',
      '  <div class="form-field">',
      '    <label>Lead stage</label>',
      `    <select id="editStageSelect">${opts}</select>`,
      '  </div>',
      '  <div class="form-field">',
      '    <label>Reason for the change</label>',
      '    <input type="text" id="editStageRemarks" placeholder="Why is this being moved by hand?" />',
      '  </div>',
      '</div>',
      '<p class="empty-state" style="margin:6px 0 0;">Setting the stage by hand stops it updating '
        + 'automatically from activity.</p>',
    ].join('\n');
  }

  function render() {
    const body = overlay.querySelector('#leadEditBody');
    const sections = SECTIONS.map((s) => [
      `<h3 style="font-size:14px;font-weight:600;margin:18px 0 8px;">${escapeHtml(s.title)}</h3>`,
      `<div class="form-grid">${s.fields.map(([k, l, t]) => fieldHtml(k, l, t, lead[k])).join('')}</div>`,
    ].join('\n')).join('');

    body.innerHTML = [
      '<h3 style="font-size:14px;font-weight:600;margin:0 0 8px;">Source &amp; ownership</h3>',
      `<div class="form-grid">${sourceHtml()}</div>`,
      sections,
      '<h3 style="font-size:14px;font-weight:600;margin:18px 0 8px;">Milestone dates</h3>',
      `<div class="form-grid">${milestoneHtml()}</div>`,
      '<h3 style="font-size:14px;font-weight:600;margin:18px 0 8px;">Lead stage</h3>',
      stageHtml(),
    ].join('\n');

    const consSelect = body.querySelector('#editConsultancySelect');
    const consOther = body.querySelector('#editConsultancyOther');
    if (consSelect) {
      consSelect.addEventListener('change', () => {
        const other = consSelect.value === OTHER_CONSULTANCY_VALUE;
        consOther.hidden = !other;
        if (!other) consOther.value = '';
      });
    }

    // Picking Disbursement reveals the amount/date pair straight away, rather
    // than making someone save, reopen, and come back for it.
    const stageSelect = body.querySelector('#editStageSelect');
    if (stageSelect) {
      stageSelect.addEventListener('change', () => {
        const name = stages.find((s) => s.id === stageSelect.value)?.name;
        const show = name === DISBURSED_STAGE
          || lead.disbursed_date != null
          || lead.disbursed_amount != null;
        body.querySelectorAll('[data-disbursed-field]').forEach((el) => { el.hidden = !show; });
      });
    }
  }

  async function save() {
    const body = overlay.querySelector('#leadEditBody');
    const btn = overlay.querySelector('#btnSaveLeadEdit');
    const fields = {};

    body.querySelectorAll('[data-field]').forEach((el) => {
      const key = el.dataset.field;
      if (el.dataset.type === 'checkbox') {
        fields[key] = el.checked;
      } else if (el.dataset.type === 'number') {
        fields[key] = el.value === '' ? null : Number(el.value);
      } else {
        fields[key] = el.value.trim() === '' ? null : el.value.trim();
      }
    });

    // "Other" is a UI token, not a consultancy id — translate it back, or the
    // uuid column gets a garbage value.
    if (fields.consultancy_id === OTHER_CONSULTANCY_VALUE) {
      fields.consultancy_id = null;
    } else if (fields.consultancy_id) {
      fields.consultancy_other_name = null;
    }

    if (!fields.student_name) {
      showToast('Student name cannot be empty.', true);
      return;
    }
    if (fields.intake_month != null && (fields.intake_month < 1 || fields.intake_month > 12)) {
      showToast('Intake month must be between 1 and 12.', true);
      return;
    }

    const stageSelect = body.querySelector('#editStageSelect');
    const stageChanged = stageSelect && stageSelect.value !== lead.current_stage_id;

    btn.disabled = true;
    try {
      await updateLead(lead.id, fields);
      // Stage goes second and separately: different permission, different
      // audit trail. If it fails the field edits above still stand, and the
      // message says which half did not apply.
      if (stageChanged) {
        const remarks = body.querySelector('#editStageRemarks')?.value || null;
        try {
          await setLeadStage(lead.id, stageSelect.value, remarks);
        } catch (stageErr) {
          console.error(stageErr);
          showToast(`Details saved, but the stage did not change: ${stageErr.message}`, true);
          close();
          onLeadUpdated();
          return;
        }
      }
      showToast('Lead updated.');
      close();
      onLeadUpdated();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save the lead.', true);
    } finally {
      btn.disabled = false;
    }
  }

  /** Opened from the drawer's action bar. */
  async function open(leadId) {
    ensureOverlay();
    const body = overlay.querySelector('#leadEditBody');
    body.innerHTML = '<p class="empty-state">Loading…</p>';
    overlay.hidden = false;

    try {
      const [detail, srcs, stgs, cons] = await Promise.all([
        getLeadDetail(leadId),
        sources.length ? sources : getLeadSources(),
        stages.length ? stages : getLeadStages(),
        consultancies.length ? consultancies : getConsultancies(),
      ]);
      lead = detail.lead;
      sources = srcs;
      stages = stgs;
      consultancies = cons;
      render();
    } catch (err) {
      console.error(err);
      body.innerHTML = '<p class="empty-state">Could not load this lead.</p>';
    }
  }

  return { open };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
