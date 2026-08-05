// validateLeadForm moved to shared/js/utils.js — this app, Lead Management
// and RM Workspace all create leads, and each carried its own copy of the
// same rules. Re-exported here so this module stays the import path.
//
// The rules were byte-for-byte equivalent to the shared version; only two
// error strings differed in wording ("Enter a valid email, or leave it
// blank" / "Select a source"), which now read the same everywhere.
import { PHONE_REGEX, EMAIL_REGEX, validateLeadForm, formatCurrency, formatDateTime } from '../../../../shared/js/utils.js';

export { validateLeadForm, formatCurrency, formatDateTime };
export { PHONE_REGEX, EMAIL_REGEX };
