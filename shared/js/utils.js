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
