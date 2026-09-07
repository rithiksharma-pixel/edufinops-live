// =========================================================
// Lead list columns — the catalog, and what each user chose.
//
// The list used to show six fixed columns while offering nine filters, so
// you could narrow to "login date this week" and not see a login date
// anywhere on screen. Every field the list can filter or sort by is now a
// column you can turn on.
//
// The choice is stored per user in localStorage rather than the database:
// it is a personal view preference, it must survive a reload without a round
// trip, and one person's column layout is nobody else's business.
// =========================================================

const STORE_KEY = 'zt-lead-columns';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dateCell = (v) => (v ? new Date(v + 'T00:00:00').toLocaleDateString('en-IN',
  { day: '2-digit', month: 'short', year: '2-digit' }) : '');

const stampCell = (v) => (v ? new Date(v).toLocaleDateString('en-IN',
  { day: '2-digit', month: 'short', year: '2-digit' }) : '');

/**
 * `key`    — stable id, stored in the user's choice
 * `label`  — column header
 * `sort`   — the leads column to order by, when sortable
 * `always` — cannot be switched off (you need something to identify the row)
 * `get`    — cell value from a lead row; returns a string, '' for blank
 */
export const LEAD_COLUMNS = [
  { key: 'student', label: 'Student', always: true, sort: 'student_name',
    get: (l) => l.student_name || '' },
  { key: 'phone', label: 'Phone', get: (l) => l.student_phone || '' },
  { key: 'email', label: 'Email', get: (l) => l.student_email || '' },
  { key: 'stage', label: 'Stage', badge: true, get: (l) => l.lead_stages?.name || '' },
  { key: 'source', label: 'Source', get: (l) => l.lead_sources?.name || '' },
  { key: 'consultancy', label: 'Consultancy', sort: 'consultancy_other_name',
    get: (l) => l.consultancies?.name || l.consultancy_other_name || '' },
  { key: 'bd', label: 'BD', sort: 'bd_name', get: (l) => l.bd_name || '' },
  { key: 'rm', label: 'Assigned RM', get: (l) => l.assigned_rm?.full_name || 'Unassigned' },
  { key: 'amount', label: 'Loan amount', numeric: true, sort: 'loan_amount_requested',
    get: (l) => (l.loan_amount_requested
      ? `${l.currency || 'INR'} ${Number(l.loan_amount_requested).toLocaleString('en-IN')}` : '') },
  { key: 'priority', label: 'Priority', sort: 'priority', get: (l) => l.priority || '' },
  { key: 'intake', label: 'Intake', get: (l) => {
    const m = l.intake_month, y = l.intake_year;
    if (m && y) return `${MONTHS[m - 1]} ${y}`;
    return y ? String(y) : (m ? MONTHS[m - 1] : '');
  } },
  { key: 'country', label: 'Country', get: (l) => l.destination_country || '' },
  { key: 'course', label: 'Course', get: (l) => l.course_name || '' },
  { key: 'university', label: 'University', get: (l) => l.university_name || '' },
  { key: 'created', label: 'Created', sort: 'created_at', get: (l) => stampCell(l.created_at) },
  { key: 'login_date', label: 'Login date', sort: 'login_date', get: (l) => dateCell(l.login_date) },
  { key: 'sanction_date', label: 'Sanction date', sort: 'sanction_date', get: (l) => dateCell(l.sanction_date) },
  { key: 'pf_date', label: 'PF date', sort: 'pf_date', get: (l) => dateCell(l.pf_date) },
  { key: 'disbursed_date', label: 'Disbursed', sort: 'disbursed_date', get: (l) => dateCell(l.disbursed_date) },
  { key: 'follow_up', label: 'Next follow-up', sort: 'next_follow_up_at',
    get: (l) => stampCell(l.next_follow_up_at) },
  { key: 'last_activity', label: 'Last activity', sort: 'last_activity_at',
    get: (l) => stampCell(l.last_activity_at) },
];

export const COLUMNS_BY_KEY = new Map(LEAD_COLUMNS.map((c) => [c.key, c]));

/**
 * What a new user sees. Deliberately the working set for a day of calling —
 * who, where they are, whose it is, and when to act — not everything at
 * once. Someone being trained should meet a readable list, then discover
 * that more is available.
 */
export const DEFAULT_COLUMNS = [
  'student', 'phone', 'stage', 'consultancy', 'rm', 'created', 'login_date', 'follow_up',
];

export function loadColumns() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_COLUMNS];
    // Drop anything that no longer exists, and keep the mandatory ones, so a
    // stored choice from an older build cannot leave a broken or blank table.
    const kept = raw.filter((k) => COLUMNS_BY_KEY.has(k));
    for (const c of LEAD_COLUMNS) {
      if (c.always && !kept.includes(c.key)) kept.unshift(c.key);
    }
    return kept.length ? kept : [...DEFAULT_COLUMNS];
  } catch {
    return [...DEFAULT_COLUMNS];   // private mode, cleared storage, corrupt value
  }
}

export function saveColumns(keys) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(keys)); } catch { /* storage off */ }
}

export function resetColumns() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* storage off */ }
  return [...DEFAULT_COLUMNS];
}
