// =========================================================
// PRESENTATION LAYER — Lead detail drawer
// =========================================================
import {
  getLeadDetail,
  getLeadExtendedDetail,
  getLeadTimeline,
  changeLeadStage,
  assignLeadToRm,
  logCall,
  CALL_STATUS_OPTIONS,
} from '../services/leadService.js';
import { initDealsTab } from './dealPanel.js';
import { initDocumentsTab } from './documentPanel.js';
import { initApplicantDetailsTab } from './applicantDetailsPanel.js';
import { initAcademicDetailsTab } from './academicDetailsPanel.js';
import { initFamilyTab } from './familyPanel.js';
import { initCollateralReferencesTab } from './collateralReferencesPanel.js';
import { initLenderStatusPanel } from './lenderStatusPanel.js';
import { getLeadStages, getAssignableRms } from '../services/lookupService.js';
import { formatCurrency, formatDateTime } from '../utils/validation.js';

let currentLeadId = null;

export function initLeadDrawer({ showToast, onLeadUpdated, currentUser }) {
  const overlay = document.getElementById('drawerOverlay');
  const btnClose = document.getElementById('btnCloseDrawer');
  const tabs = document.querySelectorAll('.tab-btn');
  const currentUserRole = currentUser.role;

  btnClose.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  function close() {
    overlay.hidden = true;
    currentLeadId = null;
  }
  window.__closeLeadDrawer = close;

  async function open(leadId) {
    if (window.__closeLeadModal) window.__closeLeadModal();
    currentLeadId = leadId;
    overlay.hidden = false;
    document.getElementById('drawerStudentName').textContent = 'Loading…';
    document.getElementById('panelOverview').innerHTML = '<p class="empty-state">Loading…</p>';

    try {
      const [{ lead, coApplicants }, extended, timeline, stages, rms] = await Promise.all([
        getLeadDetail(leadId),
        getLeadExtendedDetail(leadId),
        getLeadTimeline(leadId),
        getLeadStages(),
        // Consultants/BD never see the RM-assignment control (RLS also blocks
        // the underlying write, this just avoids showing a dead-end control)
        currentUserRole === 'Consultant' || currentUserRole === 'Business Development' ? [] : getAssignableRms(),
      ]);

      renderHeader(lead);
      renderOverview(lead, coApplicants, stages, rms, currentUser, showToast, onLeadUpdated);
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

function renderHeader(lead) {
  document.getElementById('drawerStudentName').textContent = lead.student_name;
  document.getElementById('drawerSubtitle').textContent =
    [lead.course_name, lead.university_name].filter(Boolean).join(' · ') || 'No course details yet';

  // Pinned "at a glance" facts — visible above the tabs no matter which
  // section is active, so you don't have to click into Overview to see
  // the basics while working through Applicant/Academic/etc.
  const facts = [
    ['Phone', lead.student_phone],
    ['Stage', lead.lead_stages?.name || '–'],
    ['Assigned RM', lead.assigned_rm?.full_name || 'Unassigned'],
    ['Loan type', lead.loan_type || '–'],
    ['Loan requested', formatCurrency(lead.loan_amount_requested, lead.currency)],
  ];
  document.getElementById('drawerHeaderFacts').innerHTML = facts
    .map(([k, v]) => `<div class="drawer-header-fact"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`)
    .join('');
}

function renderOverview(lead, coApplicants, stages, rms, currentUser, showToast, onLeadUpdated) {
  const panel = document.getElementById('panelOverview');
  const role = currentUser.role;
  const canEdit = ['Admin', 'Manager', 'Relationship Manager'].includes(role);

  const stageOptions = stages
    .map((s) => `<option value="${s.id}" ${s.id === lead.current_stage_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
    .join('');

  const rmOptions = rms
    .map((u) => `<option value="${u.id}" ${u.id === lead.assigned_rm_id ? 'selected' : ''}>${escapeHtml(u.full_name)}</option>`)
    .join('');

  panel.innerHTML = `
    <div class="detail-row"><span class="k">Phone</span><span class="v">${escapeHtml(lead.student_phone)}</span></div>
    <div class="detail-row"><span class="k">Email</span><span class="v">${escapeHtml(lead.student_email || '–')}</span></div>
    <div class="detail-row"><span class="k">Destination</span><span class="v">${escapeHtml(lead.destination_country || '–')}</span></div>
    <div class="detail-row"><span class="k">Loan requested</span><span class="v">${formatCurrency(lead.loan_amount_requested, lead.currency)}</span></div>
    <div class="detail-row"><span class="k">Source</span><span class="v">${escapeHtml(lead.lead_sources?.name || '–')}</span></div>
    <div class="detail-row"><span class="k">Stage</span><span class="v">
      ${canEdit
        ? `<select class="stage-select-inline" id="drawerStageSelect">${stageOptions}</select>`
        : escapeHtml(lead.lead_stages?.name || '–')}
    </span></div>
    <div class="detail-row"><span class="k">Assigned RM</span><span class="v">
      ${canEdit && rms.length > 0
        ? `<select class="stage-select-inline" id="drawerRmSelect"><option value="">Unassigned</option>${rmOptions}</select>`
        : escapeHtml(lead.assigned_rm?.full_name || 'Unassigned')}
    </span></div>
    <div class="detail-row"><span class="k">Next follow-up</span><span class="v">${formatDateTime(lead.next_follow_up_at)}</span></div>

    ${canEdit ? `
    <h3 style="font-size:14px;font-weight:500;margin:20px 0 8px;">Log a call</h3>
    <div class="form-grid">
      <div class="form-field">
        <label>Call status</label>
        <select id="callStatusSelect">${CALL_STATUS_OPTIONS.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}</select>
      </div>
      <div class="form-field">
        <label>Notes</label>
        <textarea id="callNotes" rows="1"></textarea>
      </div>
    </div>
    <div class="form-grid" id="callTaskFields" style="margin-top:10px;">
      <div class="form-field">
        <label>Follow-up task *</label>
        <input type="text" id="callTaskTitle" placeholder="e.g. Call back to confirm documents" />
      </div>
      <div class="form-field">
        <label>Due date *</label>
        <input type="date" id="callTaskDueDate" />
      </div>
    </div>
    <span class="field-error" id="callTaskError" style="display:block;margin-top:4px;"></span>
    <button class="btn btn-primary" id="btnLogCall" style="width:100%;justify-content:center;margin-top:10px;">Log call</button>
    ` : ''}

    <h3 style="font-size:14px;font-weight:500;margin:20px 0 8px;">Co-applicants</h3>
    ${
      coApplicants.length === 0
        ? '<p class="empty-state" style="padding:12px 0;">No co-applicant added yet.</p>'
        : coApplicants
            .map(
              (c) => `
        <div class="lender-app-card">
          <div class="lender-name">${escapeHtml(c.full_name)} <span style="color:var(--ink-500);font-weight:400;">(${escapeHtml(c.relationship_to_student)})</span></div>
          <div class="detail-row"><span class="k">Income</span><span class="v">${formatCurrency(c.annual_income)}</span></div>
        </div>`
            )
            .join('')
    }
  `;

  const stageSelect = document.getElementById('drawerStageSelect');
  if (stageSelect) {
    stageSelect.addEventListener('change', async (e) => {
      const newStageId = e.target.value;
      try {
        await changeLeadStage(lead.id, newStageId);
        showToast('Stage updated.');
        onLeadUpdated();
      } catch (err) {
        console.error(err);
        showToast('Could not update stage.', true);
        e.target.value = lead.current_stage_id;
      }
    });
  }

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

  const callStatusSelect = document.getElementById('callStatusSelect');
  if (callStatusSelect) {
    const taskFields = document.getElementById('callTaskFields');
    const taskError = document.getElementById('callTaskError');
    const syncTaskRequirement = () => {
      const notInterested = callStatusSelect.value === 'Not Interested';
      taskFields.style.opacity = notInterested ? '0.5' : '1';
      taskFields.querySelectorAll('input').forEach((el) => { el.disabled = notInterested; });
      taskError.textContent = '';
    };
    callStatusSelect.addEventListener('change', syncTaskRequirement);
    syncTaskRequirement();

    document.getElementById('btnLogCall').addEventListener('click', async () => {
      const callStatus = callStatusSelect.value;
      const notes = document.getElementById('callNotes').value;
      const taskTitle = document.getElementById('callTaskTitle').value.trim();
      const taskDueDate = document.getElementById('callTaskDueDate').value;

      if (callStatus !== 'Not Interested' && (!taskTitle || !taskDueDate)) {
        taskError.textContent = 'A follow-up task (title + due date) is required for this call outcome.';
        return;
      }

      const btn = document.getElementById('btnLogCall');
      btn.disabled = true;
      btn.textContent = 'Logging…';
      try {
        await logCall(
          lead.id,
          { callStatus, notes, taskTitle: callStatus === 'Not Interested' ? null : taskTitle, taskDueDate: callStatus === 'Not Interested' ? null : taskDueDate },
          currentUser.id
        );
        showToast('Call logged.');
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
}

function renderTimeline(events) {
  const panel = document.getElementById('panelTimeline');
  if (!events || events.length === 0) {
    panel.innerHTML = '<div class="empty-state-block"><div class="icon"><i class="fa-solid fa-clock-rotate-left"></i></div><div class="title">No activity recorded yet</div><p class="hint">Stage changes, calls, and updates on this lead will show up here.</p></div>';
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
