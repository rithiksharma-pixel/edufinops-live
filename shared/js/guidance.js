// =========================================================
// SHARED — all onboarding copy, in one file
//
// Tours, role guidance and the changelog live together because they are
// the same kind of asset: authored prose that has to stay true as the
// product changes. Splitting them across three files is how two of them
// quietly go stale. Nothing here is generated — if a screen changes,
// this file is the one place to update.
//
// TOURS[appKey]      first-run guided tour for that app
// ROLE_GUIDE[role]   "what you're here to do" + first actions
// CHANGELOG          newest-first, drives the What's new list
//
// Every tour step's `target` is a real selector in that app's HTML.
// A step whose target isn't present is skipped by the engine rather than
// shown pointing at nothing (see tour.js), which is what lets one tour
// serve several roles with different controls visible.
// =========================================================

// Bump a tour's version when its steps materially change and you want
// existing users to see it again. Leave it alone for copy tweaks.
export const TOUR_VERSION = 1;

const HELP_STEP = {
  target: '#ztHelpBtn',
  title: 'Everything else lives here',
  body: 'Help & tips holds this tour, what your role can do, what changed recently, and the full keyboard shortcut list. It is always in the top bar.',
  tip: 'Press <kbd>?</kbd> any time for shortcuts, or <kbd>h</kbd> to open this panel.',
  placement: 'bottom',
};

export const TOURS = {

  'lead-management': [
    {
      title: 'Welcome to Lead Management',
      body: 'This is the full record of every student loan lead, from first contact through to disbursement. Two minutes here and you will know where everything is.',
    },
    {
      target: '.zt-appswitch',
      title: 'Move between portals here',
      body: 'You only ever see the portals your role can actually open. Your current one is ticked.',
      tip: 'Press <kbd>g</kbd> then a number to jump straight to one — the numbers are shown in the menu.',
      placement: 'bottom',
    },
    {
      target: '#smartViewTabs',
      title: 'Smart Views — your saved filters',
      body: 'Set up any combination of filters below, then save it as a tab with a live count. "My overdue follow-ups" or "Bank of Baroda, awaiting sanction" become one click instead of six.',
      tip: 'The <b>+ Save view</b> button at the end of the row saves whatever filters are active right now.',
      placement: 'bottom',
    },
    {
      target: '.funnel-row',
      title: 'The pipeline at a glance',
      body: 'One card per stage with a live count. Click a card to filter the list to just that stage; click it again to clear.',
      placement: 'bottom',
    },
    {
      target: '.filter-bar',
      title: 'Narrow it down',
      body: 'Filter by stage, source, RM, priority, date range or a free-text search on name and phone. Every filter applies immediately.',
      tip: 'Press <kbd>/</kbd> to jump straight to the search box, and <kbd>c</kbd> to clear every filter.',
      placement: 'bottom',
    },
    {
      target: '.lead-table',
      title: 'Open any lead for the full picture',
      body: 'Selecting a row opens a panel with the applicant, academics, family, lenders, documents and the complete timeline — without leaving this list.',
      tip: 'Rows are keyboard reachable: <kbd>Tab</kbd> to one and press <kbd>Enter</kbd>.',
      placement: 'top',
    },
    {
      target: '#btnNewLead',
      title: 'Add a lead',
      body: 'Name, phone, loan amount and where the lead came from are all that is required to start. Everything else can be filled in later from the lead panel.',
      tip: 'Press <kbd>n</kbd> to open this from anywhere on the page.',
      placement: 'bottom',
    },
    HELP_STEP,
  ],

  'rm-workspace': [
    {
      title: 'Welcome to your workspace',
      body: 'This is your day: the leads assigned to you, what is overdue, and the calls and tasks you owe. Around ninety seconds to walk through it.',
    },
    {
      target: '#rmDashStats',
      title: 'Start with the numbers',
      body: 'Assigned leads, overdue follow-ups, and how many are on track. The first two are clickable and take you to the matching list.',
      placement: 'bottom',
    },
    {
      target: '#rmDashAttention',
      title: 'Needs attention is your to-do list',
      body: 'Overdue follow-ups, overdue tasks, and deals that have overstayed their expected turnaround — pooled into one list. Selecting any row opens that lead.',
      tip: 'If this is empty, you are genuinely up to date. That is the goal.',
      placement: 'top',
    },
    {
      target: '.sidebar-nav',
      title: 'Your working views',
      body: "Assigned Leads, Today's Follow-ups, New Leads, Documents Pending, Calls and Tasks. Each is a filtered slice of the same data, so nothing gets counted twice.",
      placement: 'bottom',
    },
    {
      target: '#btnNewLead',
      title: 'Log a lead as you take the call',
      body: 'Leads you source yourself are added here and assigned to you automatically.',
      tip: 'Press <kbd>n</kbd> to open this from anywhere on the page.',
      placement: 'bottom',
    },
    HELP_STEP,
  ],

  'manager-dashboard': [
    {
      title: 'Welcome to the team dashboard',
      body: 'Everything here is already scoped to your team — a Manager sees their reports, an Associate Team Manager sees theirs. No filtering needed.',
    },
    {
      target: '#dailyStats',
      title: "Today's business",
      body: 'New leads, disbursements and disbursed value for today. "New leads today" opens the matching filtered list.',
      placement: 'bottom',
    },
    {
      target: '#milestoneCounts',
      title: 'Milestones over any period',
      body: 'How many deals reached Login, Sanction, PF Paid and Disbursement in a window you choose. Use the presets or set exact dates, and export the underlying rows as CSV.',
      placement: 'bottom',
    },
    {
      target: '#unassignedLeadsBody',
      title: 'The unassigned queue is the one to keep empty',
      body: 'Every lead waiting for an owner, oldest first. Anything sitting longer than 48 hours is flagged.',
      tip: 'This is the highest-leverage thing on the page — an unassigned lead is not being worked by anyone.',
      placement: 'top',
    },
    {
      target: '#attentionList',
      title: 'Needs attention across the team',
      body: 'Overdue follow-ups, flagged deals and overdue tasks for everyone reporting to you. Selecting a row opens that lead in place.',
      placement: 'top',
    },
    {
      target: '#rmPerformanceBody',
      title: 'RM performance',
      body: 'Load, overdue count, deals, disbursed value, calls and connect rate per person. Selecting a row opens that RM\'s full lead list.',
      placement: 'top',
    },
    {
      target: '#leadTrendMatrix',
      title: 'Movement, not just the snapshot',
      body: 'How many leads reached each stage per day, week or month — throughput over time, with the change against the previous period.',
      placement: 'top',
    },
    HELP_STEP,
  ],

  'lender-pipeline': [
    {
      title: 'Welcome to your pipeline',
      body: 'Every case shared with your institution, and the tools to move it forward. About a minute.',
    },
    {
      target: '.sidebar-nav',
      title: 'Three places to be',
      body: 'Dashboard for the summary, Our Pipeline for the full case list, Bank Details for your institution\'s own record.',
      placement: 'bottom',
    },
    {
      target: '#dashStats',
      title: 'Where your cases stand',
      body: 'Counts by stage across everything currently shared with you.',
      placement: 'bottom',
    },
    {
      target: '#dealsBody',
      title: 'Open a case to act on it',
      body: 'Each case opens with the student profile, the documents, any queries raised, and the controls to move the stage, place it on hold, or record a decision.',
      placement: 'top',
    },
    HELP_STEP,
  ],

  'consultant-portal': [
    {
      title: 'Welcome to the consultant portal',
      body: 'Every student you have referred, and exactly where their application stands. Under a minute.',
    },
    {
      target: '#cpDashStats',
      title: 'Your students at a glance',
      body: 'How many you have referred and how they are progressing.',
      placement: 'bottom',
    },
    {
      target: '#searchInput',
      title: 'Find a student fast',
      body: 'Search by name or phone number.',
      tip: 'Press <kbd>/</kbd> to jump here from anywhere on the page.',
      placement: 'bottom',
    },
    {
      target: '#leadsBody',
      title: 'Open a student for their status',
      body: 'Current stage, progress so far, and a message thread with the team handling the application.',
      placement: 'top',
    },
    {
      target: '#btnAddLead',
      title: 'Refer a student',
      body: 'Name, phone and loan amount are enough to start. The team picks it up from there and you will see the status change here.',
      placement: 'bottom',
    },
    HELP_STEP,
  ],

  'admin-dashboard': [
    {
      title: 'Welcome to the control centre',
      body: 'The whole operation, plus the settings that everything else in the platform reads from.',
    },
    {
      target: '.sidebar-nav',
      title: 'Four areas',
      body: 'Overview for the business picture, Documents for verification status, Insights for trends, and Settings for the master data — stages, lenders, branches, document types, teams and turnaround thresholds.',
      placement: 'bottom',
    },
    {
      target: '#statGrid',
      title: 'The headline numbers',
      body: 'Leads, deals, disbursed value and pipeline health across every team.',
      placement: 'bottom',
    },
    {
      target: '#attentionList',
      title: 'What needs a decision',
      body: 'Anything stalled, overdue or breaching its expected turnaround, across the whole business.',
      placement: 'top',
    },
    HELP_STEP,
  ],

  'user-management': [
    {
      title: 'Welcome to user management',
      body: 'Who has access, what role they hold, and who they report to. Roles here decide what every other portal shows.',
    },
    {
      target: '#btnInvite',
      title: 'Invite one person',
      body: 'Email plus role is the minimum. Depending on the role you will also be asked for a reporting manager, a team, or a lender institution and branch.',
      placement: 'bottom',
    },
    {
      target: '#btnBulkInvite',
      title: 'Or paste a whole list',
      body: 'One person per line as name, email, phone. Everyone in the batch gets the same role.',
      placement: 'bottom',
    },
    {
      target: '#usersTableBody',
      title: 'Active users',
      body: 'Change a role, reassign a reporting line, or deactivate someone. Deactivating takes effect on their next sign-in and their record is kept for the audit trail.',
      placement: 'top',
    },
    {
      target: '#invitesTableBody',
      title: 'Invitations still outstanding',
      body: 'Anyone invited who has not yet set a password. Invitations can be resent or revoked from here.',
      placement: 'top',
    },
    HELP_STEP,
  ],
};

// ---------------------------------------------------------
// ROLE GUIDE — "what am I here to do?"
//
// Shown at the top of the help panel. Written per role rather than per
// app, because the honest answer to "what should I do first" depends on
// the job, not the screen.
// ---------------------------------------------------------

export const ROLE_GUIDE = {
  'Admin': {
    summary: 'You can see and configure everything. Most of your work is in Settings — the master data every other portal reads from.',
    firstSteps: [
      'Check the unassigned queue on the Manager Dashboard — nothing there should be older than 48 hours.',
      'Keep document types, lender branches and turnaround thresholds current in Admin Settings; the rest of the product derives its behaviour from them.',
      'Invite people from User Management. Their role is what decides which portals they can open.',
    ],
  },
  'Manager': {
    summary: 'You own your team\'s pipeline: who holds what, what is overdue, and where deals are getting stuck.',
    firstSteps: [
      'Clear the unassigned queue first — a lead with no owner is a lead nobody is working.',
      'Scan Needs attention for overdue follow-ups and flagged deals across your reports.',
      'Use RM performance to see load and connect rate before you assign more work.',
    ],
  },
  'Associate Team Manager': {
    summary: 'The same view as a Manager, scoped to your own direct reports. Everything is filtered for you automatically.',
    firstSteps: [
      'Start with the unassigned queue and Needs attention.',
      'Use the stage movement trends to see whether your team\'s throughput is improving week on week.',
      'Open any lead directly from the dashboard — you do not need to switch to Lead Management.',
    ],
  },
  'Relationship Manager': {
    summary: 'Your workspace is a daily queue: the leads assigned to you, the calls you owe, and the documents waiting on you.',
    firstSteps: [
      'Work Needs attention until it is empty — overdue follow-ups first.',
      'Log every call as you make it. The disposition you pick is what moves the lead\'s stage automatically.',
      'Check Documents Pending; a file cannot progress with unverified paperwork.',
    ],
  },
  'Counselor': {
    summary: 'You work leads in Lead Management, with the deal and document detail available on each one.',
    firstSteps: [
      'Save a Smart View for the slice of leads you work most — it becomes a one-click tab.',
      'Use the Documents tab\'s completeness meter to see what is outstanding on a file.',
      'Log calls from the lead panel so the timeline stays complete.',
    ],
  },
  'Business Development': {
    summary: 'You bring leads in through consultancy partnerships and track how they convert.',
    firstSteps: [
      'Add leads with the source set to BD Partnership and name the consultancy — that is what links the lead back to your channel.',
      'Filter by source to see how your channel is performing.',
      'Deal-level detail is not visible from this role; the lead\'s stage tells you where it stands.',
    ],
  },
  'Consultant': {
    summary: 'You refer students and follow their applications. Commercial detail stays with the internal team.',
    firstSteps: [
      'Refer a student with Add lead — name, phone and loan amount are enough to start.',
      'Open any student to see their current stage and message the team handling it.',
      'You will see stage changes here as the application progresses.',
    ],
  },
  'Lender': {
    summary: 'You review and decide on the cases shared with your institution.',
    firstSteps: [
      'Open Our Pipeline for every case currently with you.',
      'Raise a query on anything incomplete rather than rejecting it — the team is notified and can respond in the case.',
      'Record stage movements as they happen so the referring team sees progress without chasing.',
    ],
  },
};

export const DEFAULT_GUIDE = {
  summary: 'Use the portal switcher in the top bar to move between the areas your role can open.',
  firstSteps: ['Take the tour from this panel for a walkthrough of this screen.'],
};

// ---------------------------------------------------------
// CHANGELOG — newest first.
//
// `id` must be unique and must never be reused; the help button's unseen
// dot is driven by comparing the newest id against what this browser has
// already acknowledged.
// ---------------------------------------------------------

export const CHANGELOG = [
  {
    id: '2026-08-01-onboarding',
    date: '1 Aug 2026',
    title: 'Guided tours, help panel and keyboard shortcuts',
    items: [
      'A first-run tour for every portal, replayable any time from Help & tips.',
      'A Help & tips panel with role-specific guidance, what changed recently, and the shortcut list.',
      'Keyboard shortcuts throughout — press ? to see them all.',
      'Smart Views now explain themselves the first time you use the lead list.',
      'The lead panel now says why a stage changed, instead of only that it updates automatically.',
    ],
  },
  {
    id: '2026-07-30-tat',
    date: '30 Jul 2026',
    title: 'Configurable turnaround thresholds and lender progress',
    items: [
      'Per-stage TAT thresholds are now set in Admin Settings and drive every breach warning.',
      'A lender progress tree on each lead shows how far each institution has taken the case.',
      'Admin Insights gained day-on-day, week-on-week and month-on-month movement.',
    ],
  },
  {
    id: '2026-07-30-summary',
    date: '30 Jul 2026',
    title: 'Lead summary at the top of Overview',
    items: [
      'Recent calls, connect status and lender position summarised the moment a lead opens.',
    ],
  },
  {
    id: '2026-07-30-docs',
    date: '30 Jul 2026',
    title: 'Document file-completeness meter',
    items: [
      'Five stages of paperwork with a live verified/pending/rejected bar on each.',
      'Stages with nothing configured, or no co-applicant, now read as "not applicable" rather than 0%.',
      'Student Financials document types, plus Credit Decline and Student Decline stages.',
    ],
  },
  {
    id: '2026-07-30-email',
    date: '30 Jul 2026',
    title: 'Email notifications and the daily scorecard',
    items: [
      'RMs are emailed on task assignment and stage change.',
      'The daily digest is now a scorecard rather than a list.',
    ],
  },
  {
    id: '2026-07-29-stages',
    date: '29 Jul 2026',
    title: 'Stage details captured up front',
    items: [
      'A deal now asks for a stage\'s key details when moving into it, not afterwards.',
      'BD name is captured on BD Partnership leads and shown in the lead list.',
      'Master data export, and self-serve milestone counts by date range.',
    ],
  },
];
