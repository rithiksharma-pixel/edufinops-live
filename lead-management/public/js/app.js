// =========================================================
// PRESENTATION LAYER — App entry point
// This is the only file that "knows about everything". It wires
// services to components. Components never import each other directly.
// =========================================================
import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import { showToast } from '../../../shared/js/toast.js';
import { listLeads, getStageCounts } from './services/leadService.js';
import { getLeadStages, getLeadSources, getAssignableRms } from './services/lookupService.js';
import { renderLeadTable } from './components/leadTable.js';
import { renderFunnelCards } from './components/funnelCards.js';
import { initLeadFormModal } from './components/leadFormModal.js';
import { initLeadDrawer } from './components/leadDrawer.js';
import { initSmartViewTabs } from './components/smartViewTabs.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';

const DEFAULT_FILTERS = { stageId: '', sourceId: '', rmId: '', priority: '', overdueOnly: false, search: '', dateField: 'created_at', dateFrom: '', dateTo: '' };

const state = {
  currentUser: null,
  stages: [],
  sources: [],
  rms: [],
  filters: { ...DEFAULT_FILTERS },
};

let smartViewTabs;

async function refreshLeadsAndFunnel() {
  const tbody = document.getElementById('leadTableBody');
  try {
    const [leads, counts] = await Promise.all([listLeads(state.filters), getStageCounts(state.filters)]);
    renderLeadTable(tbody, leads, (leadId) => drawer.open(leadId));
    renderResultCount(leads.length);
    renderFunnelCards(document.getElementById('funnelRow'), state.stages, counts, state.filters.stageId, (stageId) => {
      state.filters.stageId = stageId || '';
      document.getElementById('filterStage').value = state.filters.stageId;
      smartViewTabs?.clearActive();
      refreshLeadsAndFunnel();
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
 * The count is leads.length rather than a second COUNT query because
 * listLeads already paged the whole result set into memory — asking the
 * database again could only disagree with what is actually on screen.
 *
 * The active-filter trail matters as much as the number: a count of 12 is
 * alarming until you can see it is 12 *because* someone left a date range on.
 */
function renderResultCount(n) {
  const el = document.getElementById('leadCount');
  if (!el) return;
  if (n === null) { el.textContent = ''; return; }

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
    const label = f.dateField === 'updated_at' ? 'Updated' : 'Created';
    bits.push(`${label} ${f.dateFrom || '…'} → ${f.dateTo || '…'}`);
  }

  el.innerHTML = `<strong>${n.toLocaleString('en-IN')}</strong> ${n === 1 ? 'lead' : 'leads'}`
    + (bits.length ? `<span class="lead-count-filters"> · ${bits.map(escapeHtml).join(' · ')}</span>` : '');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** Applies a filter set (from a Smart View tab or a URL deep-link) and syncs every filter-bar control to match. */
function applyFilters(filters) {
  state.filters = { ...DEFAULT_FILTERS, ...filters };
  document.getElementById('filterStage').value = state.filters.stageId;
  document.getElementById('filterSource').value = state.filters.sourceId;
  document.getElementById('filterRm').value = state.filters.rmId;
  document.getElementById('filterPriority').value = state.filters.priority;
  document.getElementById('filterOverdueOnly').checked = state.filters.overdueOnly;
  document.getElementById('filterDateField').value = state.filters.dateField;
  document.getElementById('filterDateFrom').value = state.filters.dateFrom;
  document.getElementById('filterDateTo').value = state.filters.dateTo;
  document.getElementById('filterSearch').value = state.filters.search;
  refreshLeadsAndFunnel();
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

  // Every direct filter-bar edit also clears the active Smart View tab
  // highlight — the filters no longer exactly match what was saved.
  stageSelect.addEventListener('change', (e) => {
    state.filters.stageId = e.target.value;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
  });
  sourceSelect.addEventListener('change', (e) => {
    state.filters.sourceId = e.target.value;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
  });
  rmSelect.addEventListener('change', (e) => {
    state.filters.rmId = e.target.value;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
  });

  const prioritySelect = document.getElementById('filterPriority');
  prioritySelect.addEventListener('change', (e) => {
    state.filters.priority = e.target.value;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
  });

  const overdueOnlyInput = document.getElementById('filterOverdueOnly');
  overdueOnlyInput.addEventListener('change', (e) => {
    state.filters.overdueOnly = e.target.checked;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
  });

  let searchDebounce;
  document.getElementById('filterSearch').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.filters.search = e.target.value.trim();
      smartViewTabs?.clearActive();
      refreshLeadsAndFunnel();
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
    if (state.filters.dateFrom || state.filters.dateTo) refreshLeadsAndFunnel();
  });
  dateFromInput.addEventListener('change', (e) => {
    state.filters.dateFrom = e.target.value;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
  });
  dateToInput.addEventListener('change', (e) => {
    state.filters.dateTo = e.target.value;
    smartViewTabs?.clearActive();
    refreshLeadsAndFunnel();
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

  populateFilterDropdowns();

  smartViewTabs = await initSmartViewTabs(document.getElementById('smartViewTabs'), {
    currentUser: state.currentUser,
    showToast,
    getCurrentFilters: () => ({ ...state.filters }),
    applyFilters,
  });

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