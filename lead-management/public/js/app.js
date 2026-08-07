// =========================================================
// PRESENTATION LAYER — App entry point
// This is the only file that "knows about everything". It wires
// services to components. Components never import each other directly.
// =========================================================
import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { listLeads, getStageCounts, LEAD_PAGE_SIZE, DATE_FIELD_LABELS } from './services/leadService.js';
import { getLeadStages, getLeadSources, getAssignableRms } from './services/lookupService.js';
import { renderLeadTable } from './components/leadTable.js';
import { renderFunnelCards } from './components/funnelCards.js';
import { initLeadFormModal } from './components/leadFormModal.js';
import { initLeadDrawer } from './components/leadDrawer.js';
import { initSmartViewTabs } from './components/smartViewTabs.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';

const DEFAULT_FILTERS = { stageId: '', sourceId: '', rmId: '', priority: '', overdueOnly: false, search: '', dateField: 'created_at', dateFrom: '', dateTo: '' };

/** Roles whose default view is their own book rather than the whole pipeline. */
const OWN_BOOK_ROLES = ['Relationship Manager'];

const state = {
  currentUser: null,
  stages: [],
  sources: [],
  rms: [],
  filters: { ...DEFAULT_FILTERS },
  page: 0,
  // Set at bootstrap. Non-empty means "this user's list is scoped to their own
  // leads by default" — it becomes the rmId that Clear and every Smart View
  // fall back to, instead of blank.
  scopeRmId: '',
};

/**
 * The filter set this user starts from.
 *
 * RLS still lets an RM read every lead — that is deliberate and stays, so
 * search and handovers work. This is purely about what they LAND on. Opening
 * Lead Management to 11,951 leads, 588 of which are yours, is not a working
 * list. Clearing filters returns here, not to the whole company.
 */
function defaultFilters() {
  return { ...DEFAULT_FILTERS, rmId: state.scopeRmId };
}

let smartViewTabs;

/**
 * Any filter change must return to page 1. Staying on page 7 while the
 * result set shrinks to two pages shows an empty table that looks like the
 * filter matched nothing.
 */
function resetAndRefresh() {
  state.page = 0;
  return refreshLeadsAndFunnel();
}

async function refreshLeadsAndFunnel() {
  const tbody = document.getElementById('leadTableBody');
  try {
    const [page, counts] = await Promise.all([
      listLeads(state.filters, { limit: LEAD_PAGE_SIZE, offset: state.page * LEAD_PAGE_SIZE }),
      getStageCounts(state.filters),
    ]);
    // A filter change can leave you past the end of a now-shorter result set.
    // Snap back to page 0 and refetch rather than showing an empty table.
    if (page.rows.length === 0 && page.total > 0 && state.page > 0) {
      state.page = 0;
      return refreshLeadsAndFunnel();
    }
    renderLeadTable(tbody, page.rows, (leadId) => drawer.open(leadId));
    renderResultCount(page.total, page.rows.length);
    renderPager(page.total);
    renderFunnelCards(document.getElementById('funnelRow'), state.stages, counts, state.filters.stageId, (stageId) => {
      state.filters.stageId = stageId || '';
      document.getElementById('filterStage').value = state.filters.stageId;
      smartViewTabs?.clearActive();
      resetAndRefresh();
    });
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Could not load leads. Please refresh.</td></tr>';
    renderResultCount(null);
  }
}

/**
 * "1,248 leads · Stage: Login · RM: Damini" above the table.
 *
 * `total` is the exact server-side count that came back with the same
 * request as the rows, so the strip and the pager can never disagree with
 * each other. `shown` is how many landed on this page.
 *
 * The active-filter trail matters as much as the number: a count of 12 is
 * alarming until you can see it is 12 *because* someone left a date range on.
 */
function renderResultCount(total, shown) {
  const el = document.getElementById('leadCount');
  if (!el) return;
  if (total === null) { el.textContent = ''; return; }

  const f = state.filters;
  const nameOf = (list, id, key = 'name') => list.find((x) => x.id === id)?.[key];
  const bits = [];
  if (f.stageId) bits.push(`Stage: ${nameOf(state.stages, f.stageId) || '–'}`);
  if (f.sourceId) bits.push(`Source: ${nameOf(state.sources, f.sourceId) || '–'}`);
  if (f.rmId) bits.push(`RM: ${nameOf(state.rms, f.rmId, 'full_name') || '–'}`);
  if (f.priority) bits.push(`Priority: ${f.priority}`);
  if (f.overdueOnly) bits.push('Overdue only');
  if (f.search) bits.push(`Search: "${f.search}"`);
  if (f.dateFrom || f.dateTo) {
    const label = DATE_FIELD_LABELS[f.dateField] || 'Created';
    bits.push(`${label} ${f.dateFrom || '…'} → ${f.dateTo || '…'}`);
  }

  // "1–100 of 11,949" rather than a bare page size — otherwise the number on
  // screen looks like the whole pipeline shrank to 100.
  const from = state.page * LEAD_PAGE_SIZE + 1;
  const to = state.page * LEAD_PAGE_SIZE + shown;
  const range = total > shown ? `${from.toLocaleString('en-IN')}–${to.toLocaleString('en-IN')} of ` : '';

  el.innerHTML = `<strong>${range}${total.toLocaleString('en-IN')}</strong> ${total === 1 ? 'lead' : 'leads'}`
    + (bits.length ? `<span class="lead-count-filters"> · ${bits.map(escapeHtml).join(' · ')}</span>` : '');
}

/** Prev/Next pager. Hidden entirely when everything fits on one page. */
function renderPager(total) {
  const el = document.getElementById('leadPager');
  if (!el) return;
  const pages = Math.ceil(total / LEAD_PAGE_SIZE);
  if (pages <= 1) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <button class="btn btn-ghost" id="pagePrev" ${state.page === 0 ? 'disabled' : ''}>
      <i class="fa-solid fa-chevron-left"></i> Previous</button>
    <span class="pager-status">Page ${state.page + 1} of ${pages.toLocaleString('en-IN')}</span>
    <button class="btn btn-ghost" id="pageNext" ${state.page >= pages - 1 ? 'disabled' : ''}>
      Next <i class="fa-solid fa-chevron-right"></i></button>`;

  document.getElementById('pagePrev').addEventListener('click', () => {
    if (state.page > 0) { state.page -= 1; refreshLeadsAndFunnel(); }
  });
  document.getElementById('pageNext').addEventListener('click', () => {
    if (state.page < pages - 1) { state.page += 1; refreshLeadsAndFunnel(); }
  });
}

/** Applies a filter set (from a Smart View tab or a URL deep-link) and syncs every filter-bar control to match. */
function applyFilters(filters) {
  state.filters = { ...defaultFilters(), ...filters };
  document.getElementById('filterStage').value = state.filters.stageId;
  document.getElementById('filterSource').value = state.filters.sourceId;
  document.getElementById('filterRm').value = state.filters.rmId;
  document.getElementById('filterPriority').value = state.filters.priority;
  document.getElementById('filterOverdueOnly').checked = state.filters.overdueOnly;
  document.getElementById('filterDateField').value = state.filters.dateField;
  document.getElementById('filterDateFrom').value = state.filters.dateFrom;
  document.getElementById('filterDateTo').value = state.filters.dateTo;
  document.getElementById('filterSearch').value = state.filters.search;
  resetAndRefresh();
}

function populateFilterDropdowns() {
  const stageSelect = document.getElementById('filterStage');
  const sourceSelect = document.getElementById('filterSource');
  const rmSelect = document.getElementById('filterRm');

  stageSelect.insertAdjacentHTML(
    'beforeend',
    state.stages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')
  );
  sourceSelect.insertAdjacentHTML(
    'beforeend',
    state.sources.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')
  );
  rmSelect.insertAdjacentHTML(
    'beforeend',
    state.rms.map((u) => `<option value="${u.id}">${escapeHtml(u.full_name)}</option>`).join('')
  );
  // Reflect the starting scope, so an RM sees "Praveen" selected rather than
  // "All RMs" above a list that is plainly not all RMs.
  rmSelect.value = state.filters.rmId;

  // Every direct filter-bar edit also clears the active Smart View tab
  // highlight — the filters no longer exactly match what was saved.
  stageSelect.addEventListener('change', (e) => {
    state.filters.stageId = e.target.value;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });
  sourceSelect.addEventListener('change', (e) => {
    state.filters.sourceId = e.target.value;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });
  rmSelect.addEventListener('change', (e) => {
    state.filters.rmId = e.target.value;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });

  const prioritySelect = document.getElementById('filterPriority');
  prioritySelect.addEventListener('change', (e) => {
    state.filters.priority = e.target.value;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });

  const overdueOnlyInput = document.getElementById('filterOverdueOnly');
  overdueOnlyInput.addEventListener('change', (e) => {
    state.filters.overdueOnly = e.target.checked;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });

  let searchDebounce;
  document.getElementById('filterSearch').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.filters.search = e.target.value.trim();
      smartViewTabs?.clearActive();
      resetAndRefresh();
    }, 300);
  });

  const dateFieldSelect = document.getElementById('filterDateField');
  const dateFromInput = document.getElementById('filterDateFrom');
  const dateToInput = document.getElementById('filterDateTo');

  dateFieldSelect.addEventListener('change', (e) => {
    state.filters.dateField = e.target.value;
    smartViewTabs?.clearActive();
    // Only re-query if a range is actually set — switching the basis with no
    // dates chosen changes nothing.
    if (state.filters.dateFrom || state.filters.dateTo) resetAndRefresh();
  });
  dateFromInput.addEventListener('change', (e) => {
    state.filters.dateFrom = e.target.value;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });
  dateToInput.addEventListener('change', (e) => {
    state.filters.dateTo = e.target.value;
    smartViewTabs?.clearActive();
    resetAndRefresh();
  });

  document.getElementById('btnClearFilters').addEventListener('click', () => {
    smartViewTabs?.clearActive();
    applyFilters({});
  });
}

function renderCurrentUserChip() {
  document.getElementById('currentUserName').textContent = state.currentUser.fullName;
  document.getElementById('currentUserRole').textContent = state.currentUser.role;
  document.getElementById('currentUserAvatar').textContent = state.currentUser.fullName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

let drawer;

async function bootstrap() {
  try {
    state.currentUser = await getCurrentUser();
  } catch (err) {
    // Not authenticated — in production this redirects to the Authentication
    // app's login page. Left as a console warning here since that app
    // doesn't exist yet in this build sequence.
    console.error('Auth check failed:', err);
    document.body.innerHTML =
      '<div style="max-width:420px;margin:80px auto;padding:36px;text-align:center;font-family:Inter,sans-serif;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg,14px);"><i class="fa-solid fa-right-to-bracket" style="font-size:20px;color:var(--ink-300);margin-bottom:12px;display:block;"></i><strong style="display:block;margin-bottom:4px;">Sign-in required</strong><span style="color:var(--ink-500);font-size:13px;">Please <a href="../../authentication/public/login.html" style="color:var(--accent);">sign in</a> first.</span></div>';
    return;
  }

  renderCurrentUserChip();
  mountTopbar({ app: 'lead-management', user: state.currentUser });

  const [stages, sources, rms] = await Promise.all([
    getLeadStages(),
    getLeadSources(),
    ['Consultant', 'Business Development'].includes(state.currentUser.role) ? [] : getAssignableRms(),
  ]);
  state.stages = stages;
  state.sources = sources;
  state.rms = rms;

  // An RM lands on their own book. Managers, ATMs and Admins keep the full
  // pipeline, which is the whole point of their screens.
  if (OWN_BOOK_ROLES.includes(state.currentUser.role)) {
    state.scopeRmId = state.currentUser.id;
    state.filters.rmId = state.scopeRmId;

    // Say so on the page. A list headed "Every student loan lead" that shows
    // 588 of 11,951 reads as a bug, which is how this surfaced in the first place.
    const subtitle = document.getElementById('leadPageSubtitle');
    if (subtitle) {
      subtitle.textContent = 'Leads assigned to you. Switch Assigned RM to "All RMs" to search the wider pipeline.';
    }
    const navLabel = document.querySelector('.sidebar-nav .nav-item');
    if (navLabel) navLabel.innerHTML = '<i class="fa-solid fa-diagram-project"></i> My Leads';
  }

  populateFilterDropdowns();

  // ORDER MATTERS. The drawer and the New Lead modal are wired FIRST, before
  // anything that hits the network again.
  //
  // These used to come after initSmartViewTabs, which awaits a count query per
  // saved view. When those counts were slow (they were: 1.2s each before 042)
  // or threw, bootstrap never reached this point and the New Lead button was
  // simply dead — no handler, no error, nothing to click. That is exactly the
  // "Add Lead isn't working" the team reported, and it is the same shape as
  // the saved_views outage earlier.
  //
  // Creating a lead must not depend on saved views loading.
  drawer = initLeadDrawer({
    showToast,
    onLeadUpdated: refreshLeadsAndFunnel,
    currentUser: state.currentUser,
    onOpen: (lead) => setBreadcrumb([{ label: 'All Leads', onClick: () => drawer.close() }, lead.student_name || 'Lead']),
    onClose: () => setBreadcrumb([]),
  });

  initLeadFormModal({
    onLeadCreated: refreshLeadsAndFunnel,
    showToast,
    currentUser: state.currentUser,
  });

  // Hide "New lead" for roles that shouldn't create leads directly
  // (kept as a UX nicety only — RLS is the real enforcement boundary)
  if (state.currentUser.role === 'Lender') {
    document.getElementById('btnNewLead').style.display = 'none';
  }

  // Smart Views are a convenience. Not awaited and failure-tolerant, so a
  // slow or broken saved-views load degrades to "no tabs" instead of taking
  // the whole page down with it. refreshLeadsAndFunnel already optional-chains
  // smartViewTabs, so it is safe for this to still be undefined.
  initSmartViewTabs(document.getElementById('smartViewTabs'), {
    currentUser: state.currentUser,
    showToast,
    getCurrentFilters: () => ({ ...state.filters }),
    applyFilters,
    baseFilters: defaultFilters,
    baseLabel: state.scopeRmId ? 'My Leads' : 'All Leads',
  })
    .then((tabs) => { smartViewTabs = tabs; })
    .catch((err) => {
      console.error('Smart Views failed to load', err);
      const host = document.getElementById('smartViewTabs');
      if (host) host.innerHTML = '';
    });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (window.__closeLeadModal) window.__closeLeadModal();
    if (window.__closeLeadDrawer) window.__closeLeadDrawer();
  });

  // Deep-link support from other apps' dashboards: a stat card (e.g.
  // "Active leads: 340") links here with the matching filters as query
  // params instead of duplicating a second filterable list elsewhere.
  // ?openLead=<uuid> opens one lead's drawer directly (pre-existing).
  const params = new URLSearchParams(window.location.search);
  const paramFilters = {};
  ['stageId', 'sourceId', 'rmId', 'priority', 'dateField', 'dateFrom', 'dateTo', 'search'].forEach((key) => {
    if (params.has(key)) paramFilters[key] = params.get(key);
  });
  if (params.get('overdueOnly') === 'true') paramFilters.overdueOnly = true;

  if (Object.keys(paramFilters).length > 0) {
    applyFilters(paramFilters);
  } else {
    await refreshLeadsAndFunnel();
  }

  const openLeadId = params.get('openLead');
  if (openLeadId) {
    drawer.open(openLeadId);
  }
}

guardBootstrap(bootstrap, 'Lead Management');