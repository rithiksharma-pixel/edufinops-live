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

/** Follow-up date + status badge as one HTML string, for table cells. */
export function followUpCell(isoString) {
  const status = followUpStatus(isoString);
  if (!status) return '<span style="color:var(--ink-500);">–</span>';
  return `${formatDateTime(isoString)} <span class="badge ${status.cls}" style="margin-left:6px;">${status.label}</span>`;
}
