// =========================================================
// PRESENTATION LAYER — Lead detail drawer
// =========================================================
import {
  getLeadDetail,
  getLeadExtendedDetail,
  getLeadTimeline,
  assignLeadToRm,
  logCall,
  getHighestDealStage,
  getLostReasons,
  markLeadLost,
  reopenLead,
  CALL_DISPOSITIONS,
  FOLLOWUP_REQUIRED_DISPOSITIONS,
} from '../services/leadService.js';
import { initDealsTab } from './dealPanel.js';
import { initDocumentsTab } from './documentPanel.js';
import { initApplicantDetailsTab } from './applicantDetailsPanel.js';
import { initAcademicDetailsTab } from './academicDetailsPanel.js';
import { initFamilyTab } from './familyPanel.js';
import { initCollateralReferencesTab } from './collateralReferencesPanel.js';
import { initLenderStatusPanel } from './lenderStatusPanel.js';
import { getAssignableRms } from '../services/lookupService.js';
import { formatCurrency, formatDateTime, followUpCell } from '../utils/validation.js';
import { emptyState } from '../../../../shared/js/emptyState.js';

let currentLeadId = null;

export function initLeadDrawer({ showToast, onLeadUpdated, currentUser, onOpen, onClose }) {
  const overlay = document.getElementById('drawerOverlay');
  const btnClose = document.getElementById('btnCloseDrawer');
  const tabs = document.querySelectorAll('.tab-btn');
  const currentUserRole = currentUser.role;

  btnClose.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  function activateTab(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  }
  tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

  function toggleCallForm() {
    const form = document.getElementById('drawerCallForm');
    if (form) setCallFormOpen(form.hidden);
  }

  function close() {
    overlay.hidden = true;
    currentLeadId = null;
    if (onClose) onClose();
  }
  window.__closeLeadDrawer = close;

  async function open(leadId) {
    if (window.__closeLeadModal) window.__closeLeadModal();
    currentLeadId = leadId;
    overlay.hidden = false;
    document.getElementById('drawerStudentName').textContent = 'Loading…';
    document.getElementById('panelOverview').innerHTML = '<p class="empty-state">Loading…</p>';

    const isExternalRole = currentUserRole === 'Consultant' || currentUserRole === 'Business Development';

    try {
      const [{ lead, coApplicants }, extended, timeline, rms, highestDealStage, lostReasons] = await Promise.all([
        getLeadDetail(leadId),
        getLeadExtendedDetail(leadId),
        getLeadTimeline(leadId),
        // Consultants/BD never see the RM-assignment control (RLS also blocks
        // the underlying write, this just avoids showing a dead-end control)
        isExternalRole ? [] : getAssignableRms(),
        // Effective status = furthest live deal stage (see getHighestDealStage).
        // External roles can't read deals, so skip the call and fall back to
        // the lead's own stage for them.
        isExternalRole ? null : getHighestDealStage(leadId),
        isExternalRole ? [] : getLostReasons(),
      ]);

      // A lead in the pipeline is effectively at its furthest deal's stage —
      // unless it's been marked Lost, which overrides everything.
      const effectiveStatus = lead.lost_reason_id ? 'Lead Lost' : (highestDealStage || lead.lead_stages?.name || '–');

      renderHeader(lead, effectiveStatus);
      if (onOpen) onOpen(lead);
      renderActionBar(lead, { canEdit: ['Admin', 'Manager', 'Relationship Manager'].includes(currentUserRole), activateTab, toggleCallForm });
      renderCallForm(lead, currentUser, showToast, onLeadUpdated);
      renderOverview(lead, effectiveStatus, rms, lostReasons, currentUser, showToast, onLeadUpdated, () => open(leadId));
      renderTimeline(timeline);

      // Collateral & References only makes sense for a Collateral loan —
      // hide the tab entirely rather than show an irrelevant empty section.
      document.getElementById('tabBtnCollateral').hidden = lead.loan_type !== 'Collateral';
      // Every open() starts fresh at Overview, regardless of which tab
      // was active for whatever lead was last viewed.
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'overview'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === 'overview'));

      // Refetches just the EL Details tabs after a save, without reloading
      // the whole drawer (stage/RM controls, timeline, etc. stay untouched).
      const refreshDetailsTabs = async () => {
        const [{ lead: freshLead, coApplicants: freshCoApplicants }, freshExtended] = await Promise.all([
          getLeadDetail(leadId),
          getLeadExtendedDetail(leadId),
        ]);
        await initApplicantDetailsTab(document.getElementById('panelApplicant'), freshLead, freshExtended.universities, { currentUser, showToast, onSaved: refreshDetailsTabs });
        await initAcademicDetailsTab(document.getElementById('panelAcademic'), freshLead, freshExtended.academic, { currentUser, showToast, onSaved: refreshDetailsTabs });
        await initFamilyTab(document.getElementById('panelFamily'), freshLead, freshExtended.parents, freshCoApplicants[0], { currentUser, showToast, onSaved: refreshDetailsTabs });
        await initCollateralReferencesTab(document.getElementById('panelCollateral'), freshLead, freshExtended.collateral, freshExtended.references, { currentUser, showToast, onSaved: refreshDetailsTabs });
      };

      await initApplicantDetailsTab(document.getElementById('panelApplicant'), lead, extended.universities, { currentUser, showToast, onSaved: refreshDetailsTabs });
      await initAcademicDetailsTab(document.getElementById('panelAcademic'), lead, extended.academic, { currentUser, showToast, onSaved: refreshDetailsTabs });
      await initFamilyTab(document.getElementById('panelFamily'), lead, extended.parents, coApplicants[0], { currentUser, showToast, onSaved: refreshDetailsTabs });
      await initCollateralReferencesTab(document.getElementById('panelCollateral'), lead, extended.collateral, extended.references, { currentUser, showToast, onSaved: refreshDetailsTabs });

      // Consultants/BD never see Deals/Lenders — commercially sensitive,
      // blocked by RLS too, but no point rendering a tab that always comes
      // back empty.
      const lenderMatrixPanel = document.getElementById('panelLenderMatrix');
      const dealsPanel = document.getElementById('panelLenders');
      const documentsPanel = document.getElementById('panelDocuments');
      if (currentUserRole === 'Consultant' || currentUserRole === 'Business Development') {
        lenderMatrixPanel.innerHTML = '';
        dealsPanel.innerHTML = '<p class="empty-state">Deal information isn\'t visible from this role.</p>';
        documentsPanel.innerHTML = '<p class="empty-state">Document management isn\'t visible from this role.</p>';
      } else {
        const dealsTab = await initDealsTab(dealsPanel, leadId, { currentUser, showToast, onDealUpdated: onLeadUpdated });
        await initLenderStatusPanel(lenderMatrixPanel, leadId, {
          currentUser,
          showToast,
          onShared: () => { onLeadUpdated(); dealsTab.refresh(); },
        });
        await initDocumentsTab(documentsPanel, leadId, { currentUser, showToast, coApplicants });
      }
    } catch (err) {
      console.error(err);
      showToast('Could not load this lead\'s details.', true);
    }
  }

  return { open, close };
}

function renderHeader(lead, effectiveStatus) {
  document.getElementById('drawerStudentName').textContent = lead.student_name;
  document.getElementById('drawerSubtitle').textContent =
    [lead.course_name, lead.university_name].filter(Boolean).join(' · ') || 'No course details yet';

  // Pinned "at a glance" facts — visible above the tabs no matter which
  // section is active. Status reflects the furthest live deal stage when
  // the lead is in the pipeline (see getHighestDealStage), else its own stage.
  const facts = [
    ['Phone', lead.student_phone],
    ['Status', effectiveStatus || lead.lead_stages?.name || '–'],
    ['Assigned RM', lead.assigned_rm?.full_name || 'Unassigned'],
    ['Loan type', lead.loan_type || '–'],
    ['Loan requested', formatCurrency(lead.loan_amount_requested, lead.currency)],
  ];
  document.getElementById('drawerHeaderFacts').innerHTML = facts
    .map(([k, v]) => `<div class="drawer-header-fact"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`)
    .join('');
}

// Quick-action toolbar in the top panel: call the student, log a call,
// jump to history/docs — all reachable without hunting through tabs.
function renderActionBar(lead, { canEdit, activateTab, toggleCallForm }) {
  const bar = document.getElementById('drawerActionBar');
  const phone = (lead.student_phone || '').replace(/[^\d+]/g, '');
  const buttons = [];
  if (phone) {
    buttons.push(`<a class="drawer-action-btn primary" href="tel:${escapeHtml(phone)}"><i class="fa-solid fa-phone"></i> Make a call</a>`);
  }
  if (canEdit) {
    buttons.push('<button type="button" class="drawer-action-btn" id="btnActionLogCall"><i class="fa-solid fa-pen-to-square"></i> Log call</button>');
  }
  buttons.push('<button type="button" class="drawer-action-btn" data-goto="timeline"><i class="fa-solid fa-clock-rotate-left"></i> Lead history</button>');
  buttons.push('<button type="button" class="drawer-action-btn" data-goto="documents"><i class="fa-solid fa-folder-open"></i> Documents</button>');
  bar.innerHTML = buttons.join('');

  const logBtn = document.getElementById('btnActionLogCall');
  if (logBtn) logBtn.addEventListener('click', toggleCallForm);
  bar.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.goto));
  });
}

// The log-call form lives in the top panel now (toggled by the "Log call"
// action), not buried in the Overview tab. Rendered only for roles that
// can act on a lead; hidden until the user opts to log a call.
/**
 * Open/close the log-call panel, keeping the "Log call" action button's
 * highlighted state in sync. Shared by the toolbar toggle, the panel's
 * own ✕, and the auto-close after a call is saved.
 */
function setCallFormOpen(open) {
  const form = document.getElementById('drawerCallForm');
  const btn = document.getElementById('btnActionLogCall');
  if (!form) return;
  form.hidden = !open;
  if (btn) btn.classList.toggle('active', open);
  if (open) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderCallForm(lead, currentUser, showToast, onLeadUpdated) {
  const container = document.getElementById('drawerCallForm');
  if (!['Admin', 'Manager', 'Relationship Manager'].includes(currentUser.role)) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  container.hidden = true;
  container.innerHTML = `
    <div class="callform-head">
      <h3>Log a call</h3>
      <button type="button" class="icon-btn" id="btnCloseCallForm" aria-label="Close" title="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="form-grid">
      <div class="form-field">
        <label>Outcome</label>
        <select id="callOutcomeSelect">${Object.keys(CALL_DISPOSITIONS).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>
      </div>
      <div class="form-field">
        <label>Disposition</label>
        <select id="callStatusSelect"></select>
      </div>
    </div>
    <div class="form-field" style="margin-top:10px;">
      <label>Notes</label>
      <textarea id="callNotes" rows="1"></textarea>
    </div>
    <div class="form-grid" id="callTaskFields" style="margin-top:10px;">
      <div class="form-field">
        <label>Follow-up task <span id="callTaskReq">*</span></label>
        <input type="text" id="callTaskTitle" placeholder="e.g. Call back to confirm documents" />
      </div>
      <div class="form-field">
        <label>Due date <span id="callDateReq">*</span></label>
        <input type="date" id="callTaskDueDate" />
      </div>
    </div>
    <span class="field-error" id="callTaskError" style="display:block;margin-top:4px;"></span>
    <button class="btn btn-primary" id="btnLogCall" style="width:100%;justify-content:center;margin-top:10px;">Log call</button>
  `;

  document.getElementById('btnCloseCallForm').addEventListener('click', () => setCallFormOpen(false));

  const outcomeSelect = document.getElementById('callOutcomeSelect');
  const callStatusSelect = document.getElementById('callStatusSelect');
  const taskError = document.getElementById('callTaskError');

  // Sub-disposition list follows the chosen outcome.
  const populateDispositions = () => {
    callStatusSelect.innerHTML = CALL_DISPOSITIONS[outcomeSelect.value]
      .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  };
  outcomeSelect.addEventListener('change', () => { populateDispositions(); syncTaskRequirement(); });
  populateDispositions();

  // A follow-up date is required for some dispositions (see
  // FOLLOWUP_REQUIRED_DISPOSITIONS); for the rest it's optional.
  const followupRequired = () => FOLLOWUP_REQUIRED_DISPOSITIONS.includes(callStatusSelect.value);
  const syncTaskRequirement = () => {
    const req = followupRequired();
    document.getElementById('callTaskReq').style.visibility = req ? 'visible' : 'hidden';
    document.getElementById('callDateReq').style.visibility = req ? 'visible' : 'hidden';
    taskError.textContent = '';
  };
  callStatusSelect.addEventListener('change', syncTaskRequirement);
  syncTaskRequirement();

  document.getElementById('btnLogCall').addEventListener('click', async () => {
    const callStatus = callStatusSelect.value;
    const notes = document.getElementById('callNotes').value;
    const taskTitle = document.getElementById('callTaskTitle').value.trim();
    const taskDueDate = document.getElementById('callTaskDueDate').value;

    if (followupRequired() && (!taskTitle || !taskDueDate)) {
      taskError.textContent = 'A follow-up task (title + due date) is required for this disposition.';
      return;
    }

    const btn = document.getElementById('btnLogCall');
    btn.disabled = true;
    btn.textContent = 'Logging…';
    try {
      // Save the follow-up whenever one was entered, even if optional.
      const withTask = taskTitle && taskDueDate;
      await logCall(
        lead.id,
        { callStatus, notes, taskTitle: withTask ? taskTitle : null, taskDueDate: withTask ? taskDueDate : null },
        currentUser.id
      );
      showToast('Call logged.');
      // Done — clear the form for the next call and close the panel, so
      // saving is the end of the interaction rather than leaving an open
      // panel that needs a second toggle click to dismiss.
      document.getElementById('callNotes').value = '';
      document.getElementById('callTaskTitle').value = '';
      document.getElementById('callTaskDueDate').value = '';
      setCallFormOpen(false);
      onLeadUpdated();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not log this call.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Log call';
    }
  });
}

const INTAKE_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatIntake(lead) {
  const m = lead.intake_month;
  const y = lead.intake_year;
  if (m && y) return `${INTAKE_MONTHS[m - 1]} ${y}`;
  if (y) return String(y);
  if (m) return INTAKE_MONTHS[m - 1];
  return '–';
}

// Overview = the lead's basics at a glance. Co-applicant, academic, and
// deal detail each live in their own tab; this tab stays a clean summary.
function renderOverview(lead, effectiveStatus, rms, lostReasons, currentUser, showToast, onLeadUpdated, reload) {
  const panel = document.getElementById('panelOverview');
  // The stage is computed from activity now (see recompute_lead_stage) — it
  // isn't hand-picked. The one manual override is marking a lead Lost.
  // Reassignment stays a management action: only Admin/Manager/ATM.
  const canManage = ['Admin', 'Manager', 'Associate Team Manager', 'Relationship Manager'].includes(currentUser.role);
  const canReassign = ['Admin', 'Manager', 'Associate Team Manager'].includes(currentUser.role);
  const isLost = !!lead.lost_reason_id;

  const rmOptions = rms
    .map((u) => `<option value="${u.id}" ${u.id === lead.assigned_rm_id ? 'selected' : ''}>${escapeHtml(u.full_name)}</option>`)
    .join('');

  const statusText = isLost
    ? `Lead Lost — ${escapeHtml(lead.lost_reason?.name || 'reason not recorded')}`
    : (effectiveStatus || lead.lead_stages?.name || '–');

  const basics = [
    ['Contact number', lead.student_phone || '–'],
    ['Email', lead.student_email || '–'],
    ['Intake', formatIntake(lead)],
    ['College / University', lead.university_name || '–'],
    ['Course', lead.course_name || '–'],
    ['Loan amount', formatCurrency(lead.loan_amount_requested, lead.currency)],
    ['Lead status', statusText],
  ];

  const reasonOptions = lostReasons.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

  panel.innerHTML = `
    <h3 style="font-size:14px;font-weight:600;margin:0 0 10px;">Lead basics</h3>
    ${basics.map(([k, v]) => `<div class="detail-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`).join('')}

    ${canManage ? `
    <h3 style="font-size:14px;font-weight:600;margin:22px 0 10px;">Manage</h3>
    <div class="detail-row"><span class="k">Pipeline stage</span><span class="v">${escapeHtml(lead.lead_stages?.name || '–')} <span style="color:var(--ink-500);font-weight:400;font-size:12px;">· updates automatically</span></span></div>
    <div class="detail-row"><span class="k">Assigned RM</span><span class="v">${canReassign && rms.length > 0 ? `<select class="stage-select-inline" id="drawerRmSelect"><option value="">Unassigned</option>${rmOptions}</select>` : escapeHtml(lead.assigned_rm?.full_name || 'Unassigned')}</span></div>
    <div class="detail-row"><span class="k">Next follow-up</span><span class="v">${followUpCell(lead.next_follow_up_at)}</span></div>

    ${isLost ? `
    <div class="lost-banner">
      <div><strong>Marked as Lost</strong>${lead.lost_remarks ? ` — ${escapeHtml(lead.lost_remarks)}` : ''}</div>
      <button type="button" class="btn btn-ghost" id="btnReopenLead">Reopen lead</button>
    </div>
    ` : `
    <div id="lostControls" style="margin-top:14px;">
      <button type="button" class="btn btn-ghost" id="btnShowLost"><i class="fa-solid fa-ban"></i> Mark as Lost</button>
      <div id="lostForm" hidden style="margin-top:10px;">
        <div class="form-grid">
          <div class="form-field"><label>Reason</label><select id="lostReasonSelect">${reasonOptions}</select></div>
          <div class="form-field"><label>Remarks (optional)</label><input type="text" id="lostRemarks" placeholder="Anything worth noting" /></div>
        </div>
        <button type="button" class="btn btn-primary" id="btnConfirmLost" style="margin-top:10px;">Confirm — mark Lost</button>
      </div>
    </div>
    `}
    ` : ''}
  `;

  const rmSelect = document.getElementById('drawerRmSelect');
  if (rmSelect) {
    rmSelect.addEventListener('change', async (e) => {
      const newRmId = e.target.value || null;
      try {
        await assignLeadToRm(lead.id, newRmId);
        showToast('Lead reassigned.');
        onLeadUpdated();
      } catch (err) {
        console.error(err);
        showToast('Could not reassign this lead.', true);
        e.target.value = lead.assigned_rm_id || '';
      }
    });
  }

  const showLostBtn = document.getElementById('btnShowLost');
  if (showLostBtn) {
    showLostBtn.addEventListener('click', () => {
      document.getElementById('lostForm').hidden = false;
      showLostBtn.hidden = true;
    });
    document.getElementById('btnConfirmLost').addEventListener('click', async () => {
      const btn = document.getElementById('btnConfirmLost');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await markLeadLost(lead.id, document.getElementById('lostReasonSelect').value, document.getElementById('lostRemarks').value);
        showToast('Lead marked as Lost.');
        onLeadUpdated();
        reload();
      } catch (err) {
        console.error(err);
        showToast(err.message || 'Could not mark this lead Lost.', true);
        btn.disabled = false; btn.textContent = 'Confirm — mark Lost';
      }
    });
  }

  const reopenBtn = document.getElementById('btnReopenLead');
  if (reopenBtn) {
    reopenBtn.addEventListener('click', async () => {
      reopenBtn.disabled = true; reopenBtn.textContent = 'Reopening…';
      try {
        await reopenLead(lead.id);
        showToast('Lead reopened.');
        onLeadUpdated();
        reload();
      } catch (err) {
        console.error(err);
        showToast(err.message || 'Could not reopen this lead.', true);
        reopenBtn.disabled = false; reopenBtn.textContent = 'Reopen lead';
      }
    });
  }
}

function renderTimeline(events) {
  const panel = document.getElementById('panelTimeline');
  if (!events || events.length === 0) {
    panel.innerHTML = emptyState('fa-clock-rotate-left', 'No activity recorded yet', 'Stage changes, calls, and updates on this lead will show up here.');
    return;
  }
  panel.innerHTML = events
    .map((ev) => {
      // Stage-change moments get the signature stamp — an actual
      // checkpoint reached, not just a log line. Every other event
      // (remarks, assignment, etc.) keeps the plain marker, so the
      // stamp stays meaningful rather than decorating every row.
      const isStageChange = !!ev.to_stage;
      const stampColor = /reject/i.test(ev.event_type) ? 'var(--rose)' : /disburs|closed won/i.test(ev.event_type) ? 'var(--stamp-green)' : 'var(--navy)';
      const marker = isStageChange
        ? `<div class="stage-stamp" style="--stamp-color:${stampColor};"><span class="stamp-text">${escapeHtml(ev.to_stage.name)}<br>${formatDateShort(ev.created_at)}</span></div>`
        : '<div class="timeline-dot"></div>';

      return `
    <div class="timeline-item ${isStageChange ? 'timeline-item-stamped' : ''}">
      <div class="timeline-marker-col">${marker}</div>
      <div class="timeline-content">
        <div class="timeline-event">${escapeHtml(ev.event_type)}</div>
        <div class="timeline-meta">${formatDateTime(ev.created_at)} · ${escapeHtml(ev.created_by_user?.full_name || 'System')}</div>
        ${ev.remarks ? `<div class="timeline-remarks">${escapeHtml(ev.remarks)}</div>` : ''}
        ${
          !isStageChange && ev.from_stage
            ? `<div class="timeline-remarks">${escapeHtml(ev.from_stage?.name || '–')} → ${escapeHtml(ev.to_stage?.name || '–')}</div>`
            : ''
        }
      </div>
    </div>`;
    })
    .join('');
}

function formatDateShort(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
