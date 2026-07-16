// =========================================================
// "Send portal link on WhatsApp" — builds a wa.me deep link with the
// message pre-filled. Nothing is sent from here: the link opens WhatsApp
// with the recipient and text ready, and a human taps send. That's why
// this needs no SMS provider, no credentials, and no DLT registration —
// and it means a mis-typed number is caught by the sender before it goes
// anywhere, since WhatsApp shows them the contact first.
// =========================================================
import { ROLE_HOME_ROUTES } from './config/roleRoutes.js';
import { APPS } from '../../../shared/js/appNav.js';

const BRAND = 'Zolve Tangent';

/**
 * wa.me wants digits only — no +, spaces, or dashes — including the
 * country code. Numbers are stored free-form, so normalise here.
 *
 * A bare 10-digit number is assumed Indian (+91): this is an India-based
 * team, and wa.me has no concept of a "local" number, so some default is
 * unavoidable. An explicit + (or 00) prefix is always trusted as-is.
 *
 * @returns {string|null} digits incl. country code, or null if unusable.
 */
export function toWhatsAppNumber(raw, defaultCountryCode = '91') {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const explicitIntl = trimmed.startsWith('+') || trimmed.replace(/\D/g, '').startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.slice(2); // 00 = international prefix
  if (explicitIntl) return digits || null;

  if (digits.length === 10) return defaultCountryCode + digits;
  if (digits.length === 11 && digits.startsWith('0')) return defaultCountryCode + digits.slice(1);
  return digits; // already country-coded, or something we shouldn't second-guess
}

/** The portal a role lands in, as { path, label }. */
export function portalForRole(roleName) {
  const path = ROLE_HOME_ROUTES[roleName];
  if (!path) return null;
  const app = APPS.find((a) => a.path === path);
  return { path, label: app ? app.label : 'your workspace' };
}

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'there';
}

/**
 * The message body. Two shapes, because they're different situations:
 * an active user just needs their link, while someone who hasn't accepted
 * yet must set a password from the emailed link first — sending them
 * straight to the portal would only bounce them to a login they can't pass.
 */
export function portalMessage({ fullName, email, roleName, origin, pending }) {
  const portal = portalForRole(roleName);
  const name = firstName(fullName);

  if (pending) {
    return `Hi ${name}, you've been invited to ${BRAND}${roleName ? ` as ${roleName}` : ''}.\n\n`
      + `Check your email (${email}) for the setup link to create your password.\n\n`
      + `Once that's done you can sign in here: ${origin}/authentication/public/login.html`;
  }

  const link = portal ? `${origin}${portal.path}` : `${origin}/authentication/public/login.html`;
  const where = portal ? portal.label : 'your workspace';
  return `Hi ${name}, your ${BRAND} access is ready.\n\n`
    + `${where}: ${link}\n\n`
    + `Sign in with ${email}.`;
}

/**
 * Full wa.me URL, or null when there's no usable phone number.
 * @param {{fullName,email,phone,roleName,origin,pending}} opts
 */
export function whatsappPortalUrl({ fullName, email, phone, roleName, origin, pending = false }) {
  const number = toWhatsAppNumber(phone);
  if (!number) return null;
  const text = portalMessage({ fullName, email, roleName, origin, pending });
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
