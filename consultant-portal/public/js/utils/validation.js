const PHONE_REGEX = /^[+]?[0-9\s-]{7,15}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLeadForm(payload) {
  const errors = {};
  if (!payload.student_name || payload.student_name.trim().length < 2) errors.student_name = "Enter the student's full name.";
  if (!payload.student_phone || !PHONE_REGEX.test(payload.student_phone.trim())) errors.student_phone = 'Enter a valid phone number.';
  if (payload.student_email && !EMAIL_REGEX.test(payload.student_email.trim())) errors.student_email = 'Enter a valid email, or leave it blank.';
  const amount = Number(payload.loan_amount_requested);
  if (!payload.loan_amount_requested || Number.isNaN(amount) || amount <= 0) errors.loan_amount_requested = 'Enter a loan amount greater than zero.';
  if (!payload.lead_source_id) errors.lead_source_id = 'Select a source.';
  return { valid: Object.keys(errors).length === 0, errors };
}

export function formatCurrency(amount, currency = 'INR') {
  if (amount === null || amount === undefined) return '–';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

export function formatDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
