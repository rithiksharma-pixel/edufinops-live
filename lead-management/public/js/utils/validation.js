// =========================================================
// UTILITY LAYER — Validation
// Pure functions only. No DOM access, no network calls.
// This is what unit tests target directly (see docs/TESTING.md).
// =========================================================
import { PHONE_REGEX, EMAIL_REGEX, formatCurrency, formatDate, formatDateTime, isOverdue, followUpCell, followUpStatus } from '../../../../shared/js/utils.js';

export { formatCurrency, formatDate, formatDateTime, isOverdue, followUpCell, followUpStatus };

/**
 * Validates a new-lead form payload.
 * Returns { valid: boolean, errors: { [field]: string } }
 */
export function validateLeadForm(payload) {
  const errors = {};

  if (!payload.student_name || payload.student_name.trim().length < 2) {
    errors.student_name = 'Enter the student\'s full name.';
  }

  if (!payload.student_phone || !PHONE_REGEX.test(payload.student_phone.trim())) {
    errors.student_phone = 'Enter a valid phone number.';
  }

  if (payload.student_email && !EMAIL_REGEX.test(payload.student_email.trim())) {
    errors.student_email = 'Enter a valid email address, or leave it blank.';
  }

  const amount = Number(payload.loan_amount_requested);
  if (!payload.loan_amount_requested || Number.isNaN(amount) || amount <= 0) {
    errors.loan_amount_requested = 'Enter a loan amount greater than zero.';
  }

  if (!payload.lead_source_id) {
    errors.lead_source_id = 'Select where this lead came from.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
