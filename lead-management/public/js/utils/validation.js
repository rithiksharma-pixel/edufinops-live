// =========================================================
// UTILITY LAYER — Validation
// Pure functions only. No DOM access, no network calls.
// This is what unit tests target directly (see docs/TESTING.md).
//
// validateLeadForm now lives in shared/js/utils.js — three apps create
// leads and only two of them validated, so the definition moved to the
// one place all three can reach. Re-exported here so this module stays
// the import path for this app (and for its tests).
// =========================================================
import { PHONE_REGEX, EMAIL_REGEX, validateLeadForm, formatCurrency, formatDate, formatDateTime, isOverdue, followUpCell, followUpStatus } from '../../../../shared/js/utils.js';

export { validateLeadForm, formatCurrency, formatDate, formatDateTime, isOverdue, followUpCell, followUpStatus };
export { PHONE_REGEX, EMAIL_REGEX };
