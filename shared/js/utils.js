// =========================================================
// SHARED UTILITIES — pure formatting/escaping helpers with no DOM
// dependencies beyond a throwaway <div> for escapeHtml. Previously
// duplicated (with drift) across several apps' js/utils/validation.js
// files and shared/js/appNav.js's own local copy.
// =========================================================

export const PHONE_REGEX = /^[+]?[0-9\s-]{7,15}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function formatCurrency(amount, currency = 'INR') {
  if (amount === null || amount === undefined) return '–';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function formatDate(isoString) {
  if (!isoString) return '–';
  return new Date(isoString).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(isoString) {
  if (!isoString) return '–';
  return new Date(isoString).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function isOverdue(isoString) {
  if (!isoString) return false;
  return new Date(isoString).getTime() < Date.now();
}

/**
 * Classifies a follow-up date relative to now: Overdue (in the past),
 * Due today, or Upcoming (future). Returns null when there's no date, so
 * callers can render "–". `cls` is the badge class to colour it.
 */
export function followUpStatus(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const startTomorrow = new Date(startToday.getTime() + 24 * 60 * 60 * 1000);
  if (d.getTime() < startToday.getTime()) return { label: 'Overdue', cls: 'badge-danger' };
  if (d.getTime() < startTomorrow.getTime()) return { label: 'Due today', cls: 'badge-warning' };
  return { label: 'Upcoming', cls: 'badge-neutral' };
}

/**
 * Validates a new-lead form payload. Pure — no DOM, no network — so it
 * can be unit-tested directly (see lead-management/docs/TESTING.md).
 *
 * Lives here rather than in one app's utils because THREE apps create
 * leads (Lead Management, Consultant Portal, RM Workspace) and only two
 * of them validated. An RM-entered lead could carry a malformed phone or
 * email that the identical form in Lead Management would have rejected —
 * same student, different data quality depending on who typed it in.
 * One definition is what stops that drifting apart again.
 *
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

/** Follow-up date + status badge as one HTML string, for table cells. */
export function followUpCell(isoString) {
  const status = followUpStatus(isoString);
  if (!status) return '<span style="color:var(--ink-500);">–</span>';
  return `${formatDateTime(isoString)} <span class="badge ${status.cls}" style="margin-left:6px;">${status.label}</span>`;
}
