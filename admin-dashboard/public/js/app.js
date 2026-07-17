import { supabase } from './config/supabaseClient.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';
import { emptyState } from '../../../shared/js/emptyState.js';
// CALL_STATUS_OPTIONS is owned by Lead Management's leadService.js (the
// only place calls are actually logged) — imported rather than
// re-declared so the two lists can never drift apart.
import { CALL_STATUS_OPTIONS, CONNECTED_DISPOSITIONS } from '../../../lead-management/public/js/services/leadService.js';
import { createTrendsService } from '../../../shared/js/trendsService.js';
import { renderTrendMatrix, renderGranularityPills } from '../../../shared/js/trendsView.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => { const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML; };
const inr = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value || 0));
let activeView = 'overview';

async function records(table, select) { const { data, error } = await supabase.from(table).select(select).eq('is_deleted', false); if (error) throw error; return data; }
async function requireAdmin() { const { data: auth } = await supabase.auth.getUser(); if (!auth?.user) throw new Error('Please sign in first.'); const { data, error } = await supabase.from('users').select('full_name, roles(name)').eq('id', auth.user.id).single(); if (error || data.roles?.name !== 'Admin') throw new Error('This page is available to Administrators only.'); $('userName').textContent = data.full_name; $('avatar').textContent = data.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase(); mountTopbar({ app: 'admin-dashboard', user: { fullName: data.full_name, role: 'Admin' } }); }

const STAGE_TAT_THRESHOLD_DAYS = { 'Bank Prospect': 7, Login: 5, Sanction: 10, PF: 5, Disbursement: 7 };

async function loadOverview() {
  const [leads, deals, docs, users, eventResponse, overdueTasks, stageEvents] = await Promise.all([
    records('leads', 'id, lead_stages(name), next_follow_up_at'),
    records('deals', 'id, total_disbursed_amount, is_on_hold, is_rejected, created_at, current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name)'),
    records('documents', 'id, verification_status'),
    records('users', 'id, is_active'),
    supabase.from('lead_events').select('event_type, created_at, leads(student_name), users(full_name)').eq('is_deleted', false).order('created_at', { ascending: false }).limit(8),
    supabase.from('tasks').select('id').eq('is_deleted', false).eq('is_completed', false).lt('due_date', new Date().toISOString().slice(0, 10)),
    supabase.from('deal_events').select('deal_id, to_stage_id, created_at').not('to_stage_id', 'is', null).order('created_at', { ascending: false }),
  ]);
  if (eventResponse.error) throw eventResponse.error;
  if (overdueTasks.error) throw overdueTasks.error;
  if (stageEvents.error) throw stageEvents.error;
  const totalDisbursed = deals.reduce((sum, deal) => sum + Number(deal.total_disbursed_amount || 0), 0);
  $('statGrid').innerHTML = [
    [leads.length, 'Active leads', 'fa-diagram-project', 'var(--accent)'],
    [deals.length, 'Lender deals', 'fa-building-columns', 'var(--accent)'],
    [inr(totalDisbursed), 'Disbursed amount', 'fa-sack-dollar', 'var(--success)'],
    [users.filter((user) => user.is_active).length, 'Active team members', 'fa-users', 'var(--accent)'],
  ].map(([value, label, icon, accent]) => `<div class="stat-card" style="--stat-accent:${accent};"><div class="stat-icon"><i class="fa-solid ${icon}"></i></div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`).join('');

  const stages = leads.reduce((all, lead) => { const name = lead.lead_stages?.name || 'Unassigned'; all[name] = (all[name] || 0) + 1; return all; }, {}); const largest = Math.max(1, ...Object.values(stages));
  $('stageChart').innerHTML = Object.entries(stages).map(([name, count]) => `<div class="bar-row"><span>${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${count / largest * 100}%"></div></div><strong>${count}</strong></div>`).join('') || emptyState('fa-diagram-project', 'No leads yet', 'Leads will appear here once the team starts adding them.');

  const enteredCurrentStageAt = {}; (stageEvents.data || []).forEach((ev) => { if (!enteredCurrentStageAt[ev.deal_id]) enteredCurrentStageAt[ev.deal_id] = ev.created_at; });
  const now = Date.now();
  const tatBreachedCount = deals.filter((deal) => {
    if (deal.is_on_hold || deal.is_rejected) return false;
    const stageName = deal.current_deal_stage?.name;
    if (!stageName || !STAGE_TAT_THRESHOLD_DAYS[stageName]) return false;
    const enteredAt = enteredCurrentStageAt[deal.id] || deal.created_at;
    return (now - new Date(enteredAt).getTime()) / 86400000 > STAGE_TAT_THRESHOLD_DAYS[stageName];
  }).length;
  const attention = [{ text: `${leads.filter((lead) => lead.next_follow_up_at && new Date(lead.next_follow_up_at) < new Date()).length} overdue follow-ups`, icon: 'fa-clock' }, { text: `${deals.filter((deal) => deal.is_on_hold).length} deals on hold`, icon: 'fa-hand' }, { text: `${docs.filter((doc) => doc.verification_status === 'Pending Review').length} documents awaiting review`, icon: 'fa-file-lines' }, { text: `${overdueTasks.data.length} overdue tasks`, icon: 'fa-list-check' }, { text: `${tatBreachedCount} deals overstayed their stage TAT`, icon: 'fa-hourglass-end' }].filter((item) => item.text.slice(0, 1) !== '0');
  $('attentionCount').textContent = attention.length ? attention.length : 'All clear';
  $('attentionList').innerHTML = attention.length
    ? attention.map((item) => `<div class="attention-row"><i class="fa-solid ${item.icon} row-icon"></i>${esc(item.text)}</div>`).join('')
    : emptyState('fa-circle-check', 'Everything is on track', 'No overdue items right now — nice work.');
  $('activityList').innerHTML = (eventResponse.data || []).map((event) => `<div class="activity-row"><strong>${esc(event.event_type)}</strong> · ${esc(event.leads?.student_name || 'Lead')}<div class="muted">${esc(event.users?.full_name || 'System')} · ${new Date(event.created_at).toLocaleString('en-IN')}</div></div>`).join('') || emptyState('fa-clock-rotate-left', 'No activity yet', 'Stage changes and calls will show up here as the team works leads.');
}

async function loadDocuments() { let request = supabase.from('documents').select('id,file_name,uploaded_at,verification_status,leads(student_name),document_types(name),uploaded_by_user:users!documents_uploaded_by_fkey(full_name)').eq('is_deleted', false).order('uploaded_at', { ascending: false }); if ($('documentStatus').value) request = request.eq('verification_status', $('documentStatus').value); const { data, error } = await request; if (error) throw error; $('documentsBody').innerHTML = data.length ? data.map((doc) => `<tr><td><strong>${esc(doc.document_types?.name || 'Document')}</strong><div class="muted">${esc(doc.file_name)}</div></td><td>${esc(doc.leads?.student_name || '–')}</td><td>${esc(doc.uploaded_by_user?.full_name || '–')}<div class="muted">${new Date(doc.uploaded_at).toLocaleDateString('en-IN')}</div></td><td><span class="badge ${doc.verification_status === 'Verified' ? 'verified' : doc.verification_status === 'Rejected' ? 'rejected' : ''}">${esc(doc.verification_status)}</span></td><td>${doc.verification_status === 'Pending Review' ? `<button class="btn btn-secondary" data-verify="${doc.id}">Verify</button>` : '—'}</td></tr>`).join('') : `<tr><td colspan="5">${emptyState('fa-folder-open', 'No matching documents', 'Documents appear here once RMs upload them on a lead.')}</td></tr>`; document.querySelectorAll('[data-verify]').forEach((button) => button.addEventListener('click', async () => { const { error: rpcError } = await supabase.rpc('verify_document', { p_document_id: button.dataset.verify, p_remarks: null }); if (rpcError) return showToast(rpcError.message, true); showToast('Document verified.'); loadDocuments(); })); }
// ---------- Stage movement trends (lead + bank-wise deal) ----------
const trends = createTrendsService(supabase);
const trendState = { lead: 'day', deal: 'day', lenderId: '', wired: false, lendersLoaded: false };
const DELTA_LABELS = { day: 'DoD', week: 'WoW', month: 'MoM' };

async function renderLeadTrends() {
  $('leadTrendPills').innerHTML = renderGranularityPills(trendState.lead);
  try {
    const { buckets, rows } = await trends.getLeadStageTrends(trendState.lead);
    $('leadTrendMatrix').innerHTML = renderTrendMatrix({ buckets, rows, deltaLabel: DELTA_LABELS[trendState.lead] });
  } catch (error) {
    console.error(error);
    $('leadTrendMatrix').innerHTML = emptyState('fa-triangle-exclamation', 'Could not load lead trends', 'Try refreshing the page.');
  }
}

async function renderDealTrends() {
  $('dealTrendPills').innerHTML = renderGranularityPills(trendState.deal);
  try {
    const { buckets, rows } = await trends.getDealStageTrends(trendState.deal, trendState.lenderId || null);
    $('dealTrendMatrix').innerHTML = renderTrendMatrix({ buckets, rows, deltaLabel: DELTA_LABELS[trendState.deal] });
  } catch (error) {
    console.error(error);
    $('dealTrendMatrix').innerHTML = emptyState('fa-triangle-exclamation', 'Could not load deal trends', 'Try refreshing the page.');
  }
}

// Listeners are attached once; loadReports() can re-run on every visit to
// the Reports view without stacking duplicate handlers.
function initTrendControls() {
  if (trendState.wired) return;
  trendState.wired = true;
  $('leadTrendPills').addEventListener('click', (event) => {
    const button = event.target.closest('[data-granularity]');
    if (!button || button.dataset.granularity === trendState.lead) return;
    trendState.lead = button.dataset.granularity;
    renderLeadTrends();
  });
  $('dealTrendPills').addEventListener('click', (event) => {
    const button = event.target.closest('[data-granularity]');
    if (!button || button.dataset.granularity === trendState.deal) return;
    trendState.deal = button.dataset.granularity;
    renderDealTrends();
  });
  $('dealTrendLender').addEventListener('change', (event) => {
    trendState.lenderId = event.target.value;
    renderDealTrends();
  });
}

async function populateTrendLenders() {
  if (trendState.lendersLoaded) return;
  trendState.lendersLoaded = true;
  const lenders = await trends.getTrendLenders();
  $('dealTrendLender').insertAdjacentHTML('beforeend', lenders.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join(''));
}

async function loadReports() {
  initTrendControls();
  await populateTrendLenders();
  await Promise.all([renderLeadTrends(), renderDealTrends()]);

  const [leads, deals] = await Promise.all([records('leads', 'id'), records('deals', 'id,is_on_hold,total_disbursed_amount')]);
  const total = deals.reduce((sum, deal) => sum + Number(deal.total_disbursed_amount || 0), 0);
  $('reportSnapshot').innerHTML = [[leads.length, 'Total leads'], [deals.length, 'Total deals'], [deals.filter((deal) => deal.is_on_hold).length, 'Deals on hold'], [inr(total), 'Disbursed']].map(([value, label]) => `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`).join('');

  const { data: events, error: eventsError } = await supabase.from('deal_events').select('deal_id, to_stage_id, created_at, remarks, to_stage:deal_stages!deal_events_to_stage_id_fkey(name), deals(leads(student_name))').not('to_stage_id', 'is', null).order('deal_id', { ascending: true }).order('created_at', { ascending: true });
  if (eventsError) throw eventsError;
  const byDeal = {}; events.forEach((ev) => { (byDeal[ev.deal_id] ??= []).push(ev); });
  const transitions = [];
  Object.values(byDeal).forEach((evs) => { for (let i = 1; i < evs.length; i++) { const prev = evs[i - 1]; const curr = evs[i]; const days = (new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime()) / 86400000; transitions.push({ label: `${prev.to_stage?.name || '–'} → ${curr.to_stage?.name || '–'}`, days, student: curr.deals?.leads?.student_name, remarks: curr.remarks }); } });
  const byLabel = {}; transitions.forEach((t) => { (byLabel[t.label] ??= []).push(t.days); });
  const averages = Object.entries(byLabel).map(([label, values]) => ({ label, avgDays: values.reduce((a, b) => a + b, 0) / values.length, count: values.length })).sort((a, b) => b.avgDays - a.avgDays);
  const worstOffenders = [...transitions].sort((a, b) => b.days - a.days).slice(0, 10);

  $('tatAverages').innerHTML = averages.length ? averages.map((t) => `<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;"><span>${esc(t.label)}</span><span class="amount">${t.avgDays.toFixed(1)}d avg · ${t.count} deal${t.count === 1 ? '' : 's'}</span></div></div>`).join('') : '<p class="muted">No stage transitions recorded yet.</p>';
  $('tatWorstOffenders').innerHTML = worstOffenders.length ? worstOffenders.map((t) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;"><span>${esc(t.student || '–')} <span style="color:var(--ink-500);">· ${esc(t.label)}</span></span><span class="badge">${t.days.toFixed(1)}d</span></div>${t.remarks ? `<div style="font-size:12px;color:var(--ink-500);padding:0 0 6px;">${esc(t.remarks)}</div>` : ''}`).join('') : '<p class="muted">No stage transitions recorded yet.</p>';
}
let teamPerfData = null; // cached { teams, managers, rms, leads, deals, callStats } for the currently loaded view

// Calendar week starting Monday 00:00 local time — duplicated per app
// rather than shared, matching this codebase's existing pattern of each
// app owning its own copy of small date-window helpers.
function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function loadTeamPerformance() {
  if (!teamPerfData) {
    const [teamsRes, managersRes, rmsRes, leadsRes, dealsRes, callEventsRes] = await Promise.all([
      supabase.from('teams').select('id,name').eq('is_deleted', false).order('name'),
      supabase.from('users').select('id,full_name,team_id,roles!inner(name)').in('roles.name', ['Manager', 'Associate Team Manager']).eq('is_deleted', false),
      supabase.from('users').select('id,full_name,reporting_manager_id,roles!inner(name)').eq('roles.name', 'Relationship Manager').eq('is_deleted', false),
      supabase.from('leads').select('id,assigned_manager_id,assigned_rm_id,loan_amount_requested,lead_stages(name)').eq('is_deleted', false),
      supabase.from('deals').select('id,total_disbursed_amount,leads(assigned_manager_id,assigned_rm_id)').eq('is_deleted', false),
      // Admin sees every lead_events row (is_admin() bypasses can_view_lead's
      // team scoping) — filtered to call outcomes only, keyed below by
      // created_by so each RM's own activity is counted, not just calls
      // logged on their leads by someone else.
      supabase.from('lead_events').select('event_type,created_by').in('event_type', CALL_STATUS_OPTIONS).eq('is_deleted', false).gte('created_at', startOfWeek().toISOString()),
    ]);
    for (const r of [teamsRes, managersRes, rmsRes, leadsRes, dealsRes, callEventsRes]) if (r.error) throw r.error;

    const callStats = {};
    (callEventsRes.data || []).forEach((ev) => {
      if (!ev.created_by) return;
      if (!callStats[ev.created_by]) callStats[ev.created_by] = { callCount: 0, connectedCount: 0 };
      callStats[ev.created_by].callCount += 1;
      if (CONNECTED_DISPOSITIONS.includes(ev.event_type)) callStats[ev.created_by].connectedCount += 1;
    });

    teamPerfData = { teams: teamsRes.data, managers: managersRes.data, rms: rmsRes.data, leads: leadsRes.data, deals: dealsRes.data, callStats };

    $('teamScopeSelect').innerHTML = '<option value="">All teams</option>' + teamPerfData.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  }
  renderTeamPerformance();
}

function managerIdsForTeam(teamId) { return teamPerfData.managers.filter((m) => m.team_id === teamId).map((m) => m.id); }
function rmTeamId(rmId) { const rm = teamPerfData.rms.find((r) => r.id === rmId); const mgr = rm && teamPerfData.managers.find((m) => m.id === rm.reporting_manager_id); return mgr?.team_id || null; }

function renderTeamPerformance() {
  const teamId = $('teamScopeSelect').value;
  const rmSelect = $('rmScopeSelect');
  const rmsInScope = teamId ? teamPerfData.rms.filter((r) => rmTeamId(r.id) === teamId) : teamPerfData.rms;
  const previousRm = rmSelect.value;
  rmSelect.innerHTML = '<option value="">All RMs</option>' + rmsInScope.map((r) => `<option value="${r.id}">${esc(r.full_name)}</option>`).join('');
  rmSelect.value = rmsInScope.some((r) => r.id === previousRm) ? previousRm : '';
  const rmId = rmSelect.value;

  const leadMatches = (lead) => (rmId ? lead.assigned_rm_id === rmId : teamId ? managerIdsForTeam(teamId).includes(lead.assigned_manager_id) : true);
  const dealMatches = (deal) => (rmId ? deal.leads?.assigned_rm_id === rmId : teamId ? managerIdsForTeam(teamId).includes(deal.leads?.assigned_manager_id) : true);
  const scopedLeads = teamPerfData.leads.filter(leadMatches);
  const scopedDeals = teamPerfData.deals.filter(dealMatches);
  const totalDisbursed = scopedDeals.reduce((sum, d) => sum + Number(d.total_disbursed_amount || 0), 0);

  $('teamStatGrid').innerHTML = [[scopedLeads.length, 'Leads'], [scopedDeals.length, 'Deals'], [inr(totalDisbursed), 'Disbursed amount']]
    .map(([value, label]) => `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`).join('');

  const stages = scopedLeads.reduce((all, lead) => { const name = lead.lead_stages?.name || 'Unassigned'; all[name] = (all[name] || 0) + 1; return all; }, {});
  const largest = Math.max(1, ...Object.values(stages));
  $('teamStageChart').innerHTML = Object.entries(stages).map(([name, count]) => `<div class="bar-row"><span>${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${count / largest * 100}%"></div></div><strong>${count}</strong></div>`).join('') || '<p class="muted">No leads in this scope.</p>';

  if (rmId) {
    $('teamBreakdownTitle').textContent = 'Selected RM';
    $('teamBreakdownTable').innerHTML = '<p class="muted">Showing this RM\'s own numbers — pick "All RMs" to compare their team.</p>';
  } else if (teamId) {
    $('teamBreakdownTitle').textContent = 'By RM';
    $('teamBreakdownTable').innerHTML = rmsInScope.map((rm) => {
      const rmLeads = teamPerfData.leads.filter((l) => l.assigned_rm_id === rm.id);
      const rmDeals = teamPerfData.deals.filter((d) => d.leads?.assigned_rm_id === rm.id);
      const calls = teamPerfData.callStats[rm.id] || { callCount: 0, connectedCount: 0 };
      const connectRate = calls.callCount > 0 ? `${Math.round((calls.connectedCount / calls.callCount) * 100)}%` : '–';
      return `<div class="simple-row"><strong>${esc(rm.full_name)}</strong><div class="muted">${rmLeads.length} leads · ${rmDeals.length} deals · ${calls.callCount} calls this week · ${connectRate} connect rate</div></div>`;
    }).join('') || '<p class="muted">No RMs assigned to this team yet.</p>';
  } else {
    $('teamBreakdownTitle').textContent = 'By team';
    $('teamBreakdownTable').innerHTML = teamPerfData.teams.map((team) => {
      const mgrIds = managerIdsForTeam(team.id);
      const teamLeads = teamPerfData.leads.filter((l) => mgrIds.includes(l.assigned_manager_id));
      const teamDeals = teamPerfData.deals.filter((d) => mgrIds.includes(d.leads?.assigned_manager_id));
      const rmCount = teamPerfData.rms.filter((r) => rmTeamId(r.id) === team.id).length;
      return `<div class="simple-row"><strong>${esc(team.name)}</strong><div class="muted">${rmCount} RM${rmCount === 1 ? '' : 's'} · ${teamLeads.length} leads · ${teamDeals.length} deals</div></div>`;
    }).join('') || '<p class="muted">No teams configured yet — add one in Settings.</p>';
  }
}

async function loadNotifications() { const { data, error } = await supabase.from('announcements').select('title,body,audience_role,created_at,users(full_name)').eq('is_deleted', false).order('created_at', { ascending: false }); if (error) throw error; $('notificationList').innerHTML = data.length ? data.map((item) => `<div class="notification-row"><strong>${esc(item.title)}</strong> <span class="badge">${esc(item.audience_role)}</span><div>${esc(item.body)}</div><div class="muted">${esc(item.users?.full_name || 'Admin')} · ${new Date(item.created_at).toLocaleString('en-IN')}</div></div>`).join('') : emptyState('fa-bullhorn', 'No announcements yet', 'Publish one above and it\'ll appear here for everyone to see next time they sign in.'); }
// ---------- Bulk add (reference data) ----------
// Deliberately not offered for Document types: those carry an applies_to +
// is_required + ordering that wants deciding one at a time, not pasted.

/** Non-empty trimmed lines, in order. */
function parseBulkLines(text) {
  return (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function showBulkResult(id, message, isError = false) {
  const el = $(id);
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('bulk-error', isError);
}

/** Reads a picked .csv/.txt into the matching textarea. */
function wireBulkFile(fileId, textId) {
  $(fileId).addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    $(textId).value = await file.text();
  });
}

/**
 * Bulk insert for a name-only table (consultancies, teams). Existing names
 * are filtered out client-side rather than relying on ON CONFLICT, so the
 * user gets an accurate "skipped" count and no RLS RETURNING surprises.
 */
async function bulkAddNames({ table, textId, resultId, label, plural }) {
  const names = parseBulkLines($(textId).value);
  if (names.length === 0) return showBulkResult(resultId, 'Nothing to add — paste some lines first.', true);

  const { data: existing, error: readError } = await supabase.from(table).select('name').eq('is_deleted', false);
  if (readError) return showBulkResult(resultId, readError.message, true);

  const seen = new Set((existing || []).map((r) => r.name.toLowerCase()));
  const toAdd = [];
  let skipped = 0;
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped++; continue; } // already in the table, or a repeat within this paste
    seen.add(key);
    toAdd.push(name);
  }
  if (toAdd.length === 0) return showBulkResult(resultId, `Nothing new — all ${skipped} already exist.`, true);

  const { data: auth } = await supabase.auth.getUser();
  const rows = toAdd.map((name) => ({ name, created_by: auth.user.id, updated_by: auth.user.id }));
  const { error } = await supabase.from(table).insert(rows);
  if (error) return showBulkResult(resultId, error.message, true);

  $(textId).value = '';
  const noun = toAdd.length === 1 ? label : plural;
  showBulkResult(resultId, `Added ${toAdd.length} ${noun}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.`);
  showToast(`Added ${toAdd.length} ${noun}.`);
  loadSettings();
}

/**
 * Bulk UPSERT for consultancies from "Consultancy, BD manager" lines
 * (manager optional). Unlike the name-only tables this one updates too:
 * an existing consultancy with a manager on the line gets its BD manager
 * set — that's how the whole list gets annotated in one paste. A line
 * with just an existing name is skipped rather than nulling out a
 * manager someone already recorded.
 */
async function bulkUpsertConsultancies() {
  const resultId = 'consultancyBulkResult';
  const lines = parseBulkLines($('consultancyBulkText').value);
  if (lines.length === 0) return showBulkResult(resultId, 'Nothing to add — paste some lines first.', true);

  const { data: existing, error: readError } = await supabase.from('consultancies').select('id, name, bd_manager').eq('is_deleted', false);
  if (readError) return showBulkResult(resultId, readError.message, true);
  const byName = new Map((existing || []).map((c) => [c.name.toLowerCase(), c]));

  const { data: auth } = await supabase.auth.getUser();
  const inserts = [];
  const failures = [];
  const seenInPaste = new Set();
  let updated = 0;
  let skipped = 0;

  for (const line of lines) {
    const idx = line.indexOf(',');
    const name = (idx === -1 ? line : line.slice(0, idx)).trim();
    const manager = idx === -1 ? '' : line.slice(idx + 1).trim();
    if (!name) { failures.push(`"${line}" — missing a name`); continue; }
    const key = name.toLowerCase();
    if (seenInPaste.has(key)) { skipped++; continue; }
    seenInPaste.add(key);

    const found = byName.get(key);
    if (!found) {
      inserts.push({ name, bd_manager: manager || null, created_by: auth.user.id, updated_by: auth.user.id });
    } else if (manager && manager !== (found.bd_manager || '')) {
      const { error } = await supabase.from('consultancies').update({ bd_manager: manager, updated_by: auth.user.id }).eq('id', found.id);
      if (error) failures.push(`${name} — ${error.message}`);
      else updated++;
    } else {
      skipped++; // already exists with nothing new to apply
    }
  }

  let added = 0;
  if (inserts.length) {
    const { error } = await supabase.from('consultancies').insert(inserts);
    if (error) failures.push(`could not add ${inserts.length} new: ${error.message}`);
    else added = inserts.length;
  }

  if (added || updated) $('consultancyBulkText').value = '';
  const bits = [`Added ${added}`, `updated ${updated} BD manager${updated === 1 ? '' : 's'}`, `skipped ${skipped}`];
  if (failures.length) bits.push(`${failures.length} failed: ${failures.slice(0, 3).join(' | ')}`);
  showBulkResult(resultId, `${bits.join(', ')}.`, failures.length > 0);
  if (added || updated) { showToast(`Consultancies: ${added} added, ${updated} updated.`); loadSettings(); }
}

/** Bulk insert branches from "Bank, Branch" lines. */
async function bulkAddBranches() {
  const lines = parseBulkLines($('branchBulkText').value);
  if (lines.length === 0) return showBulkResult('branchBulkResult', 'Nothing to add — paste some lines first.', true);

  const [lendersRes, branchesRes] = await Promise.all([
    supabase.from('lenders').select('id,name').eq('is_deleted', false),
    supabase.from('lender_branches').select('lender_id,name').eq('is_deleted', false),
  ]);
  if (lendersRes.error) return showBulkResult('branchBulkResult', lendersRes.error.message, true);
  if (branchesRes.error) return showBulkResult('branchBulkResult', branchesRes.error.message, true);

  const lenderByName = new Map(lendersRes.data.map((l) => [l.name.toLowerCase(), l.id]));
  const seen = new Set((branchesRes.data || []).map((b) => `${b.lender_id}|${b.name.toLowerCase()}`));

  const rows = [];
  const unmatched = [];
  let skipped = 0;
  for (const line of lines) {
    const idx = line.indexOf(',');
    if (idx === -1) { unmatched.push(line); continue; }
    const bank = line.slice(0, idx).trim();
    const branch = line.slice(idx + 1).trim();
    if (!bank || !branch) { unmatched.push(line); continue; }
    const lenderId = lenderByName.get(bank.toLowerCase());
    if (!lenderId) { unmatched.push(line); continue; }
    const key = `${lenderId}|${branch.toLowerCase()}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    rows.push({ lender_id: lenderId, name: branch });
  }

  if (rows.length === 0) {
    return showBulkResult('branchBulkResult', `Nothing added. ${skipped} duplicate(s), ${unmatched.length} unusable line(s)${unmatched.length ? `: ${unmatched.slice(0, 3).join(' | ')}` : ''}`, true);
  }

  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from('lender_branches').insert(rows.map((r) => ({ ...r, created_by: auth.user.id, updated_by: auth.user.id })));
  if (error) return showBulkResult('branchBulkResult', error.message, true);

  $('branchBulkText').value = '';
  const bits = [`Added ${rows.length} branch${rows.length === 1 ? '' : 'es'}`];
  if (skipped) bits.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
  if (unmatched.length) bits.push(`${unmatched.length} line(s) had an unknown bank or bad format: ${unmatched.slice(0, 3).join(' | ')}`);
  showBulkResult('branchBulkResult', `${bits.join(', ')}.`, unmatched.length > 0);
  showToast(`Added ${rows.length} branch${rows.length === 1 ? '' : 'es'}.`);
  loadSettings();
}

function initBulkAdd() {
  wireBulkFile('branchBulkFile', 'branchBulkText');
  wireBulkFile('consultancyBulkFile', 'consultancyBulkText');
  wireBulkFile('teamBulkFile', 'teamBulkText');
  $('branchBulkBtn').addEventListener('click', () => bulkAddBranches().catch((e) => showBulkResult('branchBulkResult', e.message, true)));
  $('consultancyBulkBtn').addEventListener('click', () => bulkUpsertConsultancies().catch((e) => showBulkResult('consultancyBulkResult', e.message, true)));
  $('teamBulkBtn').addEventListener('click', () => bulkAddNames({ table: 'teams', textId: 'teamBulkText', resultId: 'teamBulkResult', label: 'team', plural: 'teams' }).catch((e) => showBulkResult('teamBulkResult', e.message, true)));
}

async function loadSettings() {
  const { data, error } = await supabase.from('document_types').select('name,applies_to,is_required').eq('is_deleted', false).order('sequence_order');
  if (error) throw error;
  $('documentTypesList').innerHTML = data.map((type) => `<div class="simple-row"><strong>${esc(type.name)}</strong><div class="muted">${esc(type.applies_to)}${type.is_required ? ' · Required' : ''}</div></div>`).join('') || '<p class="muted">No types configured.</p>';

  const [{ data: lenders, error: lendersError }, { data: branches, error: branchesError }, { data: consultancies, error: consultanciesError }, { data: teams, error: teamsError }] = await Promise.all([
    supabase.from('lenders').select('id,name').eq('is_deleted', false).order('name'),
    supabase.from('lender_branches').select('name,lenders(name)').eq('is_deleted', false).order('name'),
    supabase.from('consultancies').select('name, bd_manager').eq('is_deleted', false).order('name'),
    supabase.from('teams').select('name').eq('is_deleted', false).order('name'),
  ]);
  if (lendersError) throw lendersError;
  if (branchesError) throw branchesError;
  if (consultanciesError) throw consultanciesError;
  if (teamsError) throw teamsError;
  $('branchLenderSelect').innerHTML = lenders.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('lenderBranchesList').innerHTML = branches.map((b) => `<div class="simple-row"><strong>${esc(b.name)}</strong><div class="muted">${esc(b.lenders?.name || '–')}</div></div>`).join('') || '<p class="muted">No branches configured.</p>';
  $('consultanciesList').innerHTML = consultancies.map((c) => `<div class="simple-row"><strong>${esc(c.name)}</strong><div class="muted">${c.bd_manager ? `BD manager: ${esc(c.bd_manager)}` : 'No BD manager yet'}</div></div>`).join('') || '<p class="muted">No consultancies configured.</p>';
  $('teamsList').innerHTML = teams.map((t) => `<div class="simple-row"><strong>${esc(t.name)}</strong></div>`).join('') || '<p class="muted">No teams configured.</p>';
}
async function loadActive() { try { if (activeView === 'overview') await loadOverview(); if (activeView === 'documents') await loadDocuments(); if (activeView === 'reports') await loadReports(); if (activeView === 'team-performance') await loadTeamPerformance(); if (activeView === 'notifications') await loadNotifications(); if (activeView === 'settings') await loadSettings(); } catch (error) { console.error(error); showToast(error.message || 'Could not load this section.', true); } }
function changeView(view) { activeView = view; if (view === 'team-performance') teamPerfData = null; document.querySelectorAll('.view').forEach((section) => { section.hidden = section.id !== `${view}View`; }); document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view)); const labels = { overview: ['Business overview', 'Your complete loan operations picture.'], documents: ['Document centre', 'Verify and track all submitted files.'], reports: ['Reports', 'Export and review business performance.'], 'team-performance': ['Team performance', 'Overall, team-wise, and RM-wise breakdowns.'], notifications: ['Notifications', 'Keep every team in the loop.'], settings: ['Settings', 'Manage the system reference data.'] }; $('viewTitle').textContent = labels[view][0]; $('viewSubtitle').textContent = labels[view][1]; setBreadcrumb(view === 'overview' ? [] : [labels[view][0]]); loadActive(); }
document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.addEventListener('click', (event) => { event.preventDefault(); changeView(item.dataset.view); })); $('refreshButton').addEventListener('click', () => { if (activeView === 'team-performance') teamPerfData = null; loadActive(); }); $('documentStatus').addEventListener('change', loadDocuments); $('teamScopeSelect').addEventListener('change', renderTeamPerformance); $('rmScopeSelect').addEventListener('change', renderTeamPerformance);
$('notificationForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('announcements').insert({ title: form.get('title').trim(), body: form.get('body').trim(), audience_role: form.get('audience'), created_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Announcement published.'); loadNotifications(); });
$('documentTypeForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: ranks } = await supabase.from('document_types').select('sequence_order').order('sequence_order', { ascending: false }).limit(1); const { error } = await supabase.from('document_types').insert({ name: form.get('name').trim(), applies_to: form.get('applies_to'), is_required: form.get('is_required') === 'on', sequence_order: (ranks?.[0]?.sequence_order || 0) + 10 }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Document type added.'); loadSettings(); });
$('lenderBranchForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('lender_branches').insert({ lender_id: form.get('lender_id'), name: form.get('name').trim(), created_by: auth.user.id, updated_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Branch added.'); loadSettings(); });
$('consultancyForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('consultancies').insert({ name: form.get('name').trim(), bd_manager: (form.get('bd_manager') || '').trim() || null, created_by: auth.user.id, updated_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Consultancy added.'); loadSettings(); });
$('teamForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('teams').insert({ name: form.get('name').trim(), created_by: auth.user.id, updated_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Team added.'); loadSettings(); });
initBulkAdd();
requireAdmin().then(loadActive).catch((error) => { document.body.innerHTML = `<main style="padding:48px;font-family:Inter,sans-serif"><h1>Access unavailable</h1><p>${esc(error.message)}</p><a href="../../authentication/public/login.html">Go to sign in</a></main>`; });
