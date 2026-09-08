// =========================================================
// Standard views — the work, named.
//
// Defined in code rather than seeded as saved_views rows, because these are
// part of the product: nobody should be able to delete "Overdue follow-ups"
// for the whole company, and a fresh deployment should have them without a
// data migration.
//
// Each view's filters are a FUNCTION, so relative dates ("this week") are
// computed when the view is used rather than frozen at page load, and stage
// ids are resolved from whatever the database actually holds.
//
// They stack on top of the caller's base filters, which for an RM pins them
// to their own book — so "Untouched 30+ days" means THEIR untouched leads,
// not the company's.
// =========================================================

const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
};

const stageId = (stages, name) => stages.find((s) => s.name === name)?.id ?? '';

export const STANDARD_VIEWS = [
  {
    id: 'std-overdue',
    name: 'Overdue',
    hint: 'Follow-ups whose date has passed',
    filters: () => ({ overdueOnly: true, openOnly: true }),
  },
  {
    id: 'std-stale',
    name: 'Untouched 30+ days',
    hint: 'No contact recorded in over a month',
    alert: true,
    filters: () => ({ notContactedDays: 30, openOnly: true }),
  },
  {
    id: 'std-new',
    name: 'New this week',
    hint: 'Created in the last seven days',
    filters: () => ({ dateField: 'created_at', dateFrom: daysAgo(7) }),
  },
  {
    id: 'std-login',
    name: 'At Login',
    hint: 'Logged in, not yet sanctioned',
    filters: (stages) => ({ stageId: stageId(stages, 'Login'), openOnly: true }),
  },
];

/** Resolve every standard view against the live stage list. */
export function resolveStandardViews(stages = []) {
  return STANDARD_VIEWS.map((v) => ({
    id: v.id,
    name: v.name,
    hint: v.hint,
    alert: !!v.alert,
    standard: true,
    filters: v.filters(stages),
  }));
}

export const isStandardView = (id) => typeof id === 'string' && id.startsWith('std-');
