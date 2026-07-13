// =========================================================
// PRESENTATION LAYER — New Lead modal
// =========================================================
import { validateLeadForm } from '../utils/validation.js';
import { createLead } from '../services/leadService.js';
import { getLeadSources, getLeadStages } from '../services/lookupService.js';

export function initLeadFormModal({ onLeadCreated, showToast, currentUser }) {
  const overlay = document.getElementById('leadModalOverlay');
  const form = document.getElementById('leadForm');
  const btnOpen = document.getElementById('btnNewLead');
  const btnClose = document.getElementById('btnCloseModal');
  const btnCancel = document.getElementById('btnCancelModal');
  const sourceSelect = document.getElementById('f_lead_source_id');

  async function open() {
    if (window.__closeLeadDrawer) window.__closeLeadDrawer();
    clearErrors();
    form.reset();
    if (sourceSelect.options.length <= 0) {
      const sources = await getLeadSources();
      sourceSelect.innerHTML = sources
        .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
        .join('');
    }
    overlay.hidden = false;
  }

  function close() {
    overlay.hidden = true;
  }
  window.__closeLeadModal = close;

  function clearErrors() {
    form.querySelectorAll('.field-error').forEach((el) => (el.textContent = ''));
    form.querySelectorAll('.form-field').forEach((el) => el.classList.remove('has-error'));
  }

  function showErrors(errors) {
    clearErrors();
    for (const [field, message] of Object.entries(errors)) {
      const errorEl = form.querySelector(`[data-error-for="${field}"]`);
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.closest('.form-field')?.classList.add('has-error');
      }
    }
  }

  btnOpen.addEventListener('click', open);
  btnClose.addEventListener('click', close);
  btnCancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    const { valid, errors } = validateLeadForm(payload);
    if (!valid) {
      showErrors(errors);
      return;
    }

    const submitBtn = document.getElementById('btnSubmitLead');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const stages = await getLeadStages();
      const openingStage = stages.find((s) => s.sequence_order === Math.min(...stages.map((x) => x.sequence_order)));

      await createLead(
        {
          student_name: payload.student_name.trim(),
          student_phone: payload.student_phone.trim(),
          student_email: payload.student_email?.trim() || null,
          course_name: payload.course_name?.trim() || null,
          university_name: payload.university_name?.trim() || null,
          destination_country: payload.destination_country?.trim() || null,
          loan_amount_requested: Number(payload.loan_amount_requested),
          lead_source_id: payload.lead_source_id,
          source_user_id: currentUser.id,
        },
        currentUser.id,
        openingStage.id
      );

      showToast('Lead saved.');
      close();
      onLeadCreated();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save this lead. Please try again.', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save lead';
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
