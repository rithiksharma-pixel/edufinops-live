// =========================================================
// PRESENTATION LAYER — App entry point
// This is the only file that "knows about everything". It wires
// services to components. Components never import each other directly.
// =========================================================
import { getCurrentUser } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { listLeads, getStageCounts } from './services/leadService.js';
import { getLeadStages, getLeadSources, getAssignableRms } from './services/lookupService.js';
import { renderLeadTable } from './components/leadTable.js';
import { renderFunnelCards } from './components/funnelCards.js';
import { initLeadFormModal } from './components/leadFormModal.js';
import { initLeadDrawer } from './components/leadDrawer.js';

const state = {
  currentUser: null,
  stages: [],
  sources: [],
  rms: [],
  filters: { stageId: '', sourceId: '', rmId: '', search: '' },
};

const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

async function refreshLeadsAndFunnel() {
  const tbody = document.getElementById('leadTableBody');
  try {
    const [leads, counts] = await Promise.all([listLeads(state.filters), getStageCounts()]);
    renderLeadTable(tbody, leads, (leadId) => drawer.open(leadId));
    renderFunnelCards(document.getElementById('funnelRow'), state.stages, counts);
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Could not load leads. Please refresh.</td></tr>';
  }
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

  stageSelect.addEventListener('change', (e) => {
    state.filters.stageId = e.target.value;
    refreshLeadsAndFunnel();
  });
  sourceSelect.addEventListener('change', (e) => {
    state.filters.sourceId = e.target.value;
    refreshLeadsAndFunnel();
  });
  rmSelect.addEventListener('change', (e) => {
    state.filters.rmId = e.target.value;
    refreshLeadsAndFunnel();
  });

  let searchDebounce;
  document.getElementById('filterSearch').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.filters.search = e.target.value.trim();
      refreshLeadsAndFunnel();
    }, 300);
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

  await refreshLeadsAndFunnel();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (window.__closeLeadModal) window.__closeLeadModal();
    if (window.__closeLeadDrawer) window.__closeLeadDrawer();
  });

  // Deep-link support: /lead-management/public/index.html?openLead=<uuid>
  // lets other apps (RM Workspace) link straight into a lead's detail
  // drawer instead of duplicating the Deals/Documents/Timeline UI.
  const params = new URLSearchParams(window.location.search);
  const openLeadId = params.get('openLead');
  if (openLeadId) {
    drawer.open(openLeadId);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

bootstrap();
