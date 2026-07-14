import { supabase } from './config/supabaseClient.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => { const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML; };
const inr = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value || 0));
let activeView = 'overview';

function showToast(message, error = false) { const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => { el.hidden = true; }, 3200); }
async function records(table, select) { const { data, error } = await supabase.from(table).select(select).eq('is_deleted', false); if (error) throw error; return data; }
async function requireAdmin() { const { data: auth } = await supabase.auth.getUser(); if (!auth?.user) throw new Error('Please sign in first.'); const { data, error } = await supabase.from('users').select('full_name, roles(name)').eq('id', auth.user.id).single(); if (error || data.roles?.name !== 'Admin') throw new Error('This page is available to Administrators only.'); $('userName').textContent = data.full_name; $('avatar').textContent = data.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase(); }

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
  $('statGrid').innerHTML = [[leads.length, 'Active leads'], [deals.length, 'Lender deals'], [inr(totalDisbursed), 'Disbursed amount'], [users.filter((user) => user.is_active).length, 'Active team members']].map(([value, label]) => `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`).join('');
  const stages = leads.reduce((all, lead) => { const name = lead.lead_stages?.name || 'Unassigned'; all[name] = (all[name] || 0) + 1; return all; }, {}); const largest = Math.max(1, ...Object.values(stages));
  $('stageChart').innerHTML = Object.entries(stages).map(([name, count]) => `<div class="bar-row"><span>${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${count / largest * 100}%"></div></div><strong>${count}</strong></div>`).join('') || '<p class="muted">No leads yet.</p>';
  const enteredCurrentStageAt = {}; (stageEvents.data || []).forEach((ev) => { if (!enteredCurrentStageAt[ev.deal_id]) enteredCurrentStageAt[ev.deal_id] = ev.created_at; });
  const now = Date.now();
  const tatBreachedCount = deals.filter((deal) => {
    if (deal.is_on_hold || deal.is_rejected) return false;
    const stageName = deal.current_deal_stage?.name;
    if (!stageName || !STAGE_TAT_THRESHOLD_DAYS[stageName]) return false;
    const enteredAt = enteredCurrentStageAt[deal.id] || deal.created_at;
    return (now - new Date(enteredAt).getTime()) / 86400000 > STAGE_TAT_THRESHOLD_DAYS[stageName];
  }).length;
  const attention = [{ text: `${leads.filter((lead) => lead.next_follow_up_at && new Date(lead.next_follow_up_at) < new Date()).length} overdue follow-ups` }, { text: `${deals.filter((deal) => deal.is_on_hold).length} deals on hold` }, { text: `${docs.filter((doc) => doc.verification_status === 'Pending Review').length} documents awaiting review` }, { text: `${overdueTasks.data.length} overdue tasks` }, { text: `${tatBreachedCount} deals overstayed their stage TAT` }].filter((item) => item.text.slice(0, 1) !== '0');
  $('attentionCount').textContent = attention.length ? attention.length : 'All clear'; $('attentionList').innerHTML = attention.length ? attention.map((item) => `<div class="attention-row">${esc(item.text)}</div>`).join('') : '<p class="muted">Everything is on track.</p>';
  $('activityList').innerHTML = (eventResponse.data || []).map((event) => `<div class="activity-row"><strong>${esc(event.event_type)}</strong> · ${esc(event.leads?.student_name || 'Lead')}<div class="muted">${esc(event.users?.full_name || 'System')} · ${new Date(event.created_at).toLocaleString('en-IN')}</div></div>`).join('') || '<p class="muted">No activity yet.</p>';
}

async function loadDocuments() { let request = supabase.from('documents').select('id,file_name,uploaded_at,verification_status,leads(student_name),document_types(name),uploaded_by_user:users!documents_uploaded_by_fkey(full_name)').eq('is_deleted', false).order('uploaded_at', { ascending: false }); if ($('documentStatus').value) request = request.eq('verification_status', $('documentStatus').value); const { data, error } = await request; if (error) throw error; $('documentsBody').innerHTML = data.length ? data.map((doc) => `<tr><td><strong>${esc(doc.document_types?.name || 'Document')}</strong><div class="muted">${esc(doc.file_name)}</div></td><td>${esc(doc.leads?.student_name || '–')}</td><td>${esc(doc.uploaded_by_user?.full_name || '–')}<div class="muted">${new Date(doc.uploaded_at).toLocaleDateString('en-IN')}</div></td><td><span class="badge ${doc.verification_status === 'Verified' ? 'verified' : doc.verification_status === 'Rejected' ? 'rejected' : ''}">${esc(doc.verification_status)}</span></td><td>${doc.verification_status === 'Pending Review' ? `<button class="btn btn-secondary" data-verify="${doc.id}">Verify</button>` : '—'}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">No matching documents.</td></tr>'; document.querySelectorAll('[data-verify]').forEach((button) => button.addEventListener('click', async () => { const { error: rpcError } = await supabase.rpc('verify_document', { p_document_id: button.dataset.verify, p_remarks: null }); if (rpcError) return showToast(rpcError.message, true); showToast('Document verified.'); loadDocuments(); })); }
async function loadReports() {
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
async function loadNotifications() { const { data, error } = await supabase.from('announcements').select('title,body,audience_role,created_at,users(full_name)').eq('is_deleted', false).order('created_at', { ascending: false }); if (error) throw error; $('notificationList').innerHTML = data.length ? data.map((item) => `<div class="notification-row"><strong>${esc(item.title)}</strong> <span class="badge">${esc(item.audience_role)}</span><div>${esc(item.body)}</div><div class="muted">${esc(item.users?.full_name || 'Admin')} · ${new Date(item.created_at).toLocaleString('en-IN')}</div></div>`).join('') : '<p class="muted">No announcements published.</p>'; }
async function loadSettings() {
  const { data, error } = await supabase.from('document_types').select('name,applies_to,is_required').eq('is_deleted', false).order('sequence_order');
  if (error) throw error;
  $('documentTypesList').innerHTML = data.map((type) => `<div class="simple-row"><strong>${esc(type.name)}</strong><div class="muted">${esc(type.applies_to)}${type.is_required ? ' · Required' : ''}</div></div>`).join('') || '<p class="muted">No types configured.</p>';

  const [{ data: lenders, error: lendersError }, { data: branches, error: branchesError }, { data: consultancies, error: consultanciesError }] = await Promise.all([
    supabase.from('lenders').select('id,name').eq('is_deleted', false).order('name'),
    supabase.from('lender_branches').select('name,lenders(name)').eq('is_deleted', false).order('name'),
    supabase.from('consultancies').select('name').eq('is_deleted', false).order('name'),
  ]);
  if (lendersError) throw lendersError;
  if (branchesError) throw branchesError;
  if (consultanciesError) throw consultanciesError;
  $('branchLenderSelect').innerHTML = lenders.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('lenderBranchesList').innerHTML = branches.map((b) => `<div class="simple-row"><strong>${esc(b.name)}</strong><div class="muted">${esc(b.lenders?.name || '–')}</div></div>`).join('') || '<p class="muted">No branches configured.</p>';
  $('consultanciesList').innerHTML = consultancies.map((c) => `<div class="simple-row"><strong>${esc(c.name)}</strong></div>`).join('') || '<p class="muted">No consultancies configured.</p>';
}
async function loadActive() { try { if (activeView === 'overview') await loadOverview(); if (activeView === 'documents') await loadDocuments(); if (activeView === 'reports') await loadReports(); if (activeView === 'notifications') await loadNotifications(); if (activeView === 'settings') await loadSettings(); } catch (error) { console.error(error); showToast(error.message || 'Could not load this section.', true); } }
function changeView(view) { activeView = view; document.querySelectorAll('.view').forEach((section) => { section.hidden = section.id !== `${view}View`; }); document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view)); const labels = { overview: ['Business overview', 'Your complete loan operations picture.'], documents: ['Document centre', 'Verify and track all submitted files.'], reports: ['Reports', 'Export and review business performance.'], notifications: ['Notifications', 'Keep every team in the loop.'], settings: ['Settings', 'Manage the system reference data.'] }; $('viewTitle').textContent = labels[view][0]; $('viewSubtitle').textContent = labels[view][1]; loadActive(); }
document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.addEventListener('click', (event) => { event.preventDefault(); changeView(item.dataset.view); })); $('refreshButton').addEventListener('click', loadActive); $('documentStatus').addEventListener('change', loadDocuments); $('signOut').addEventListener('click', async () => { await supabase.auth.signOut(); window.location.href = '../../authentication/public/login.html'; });
$('notificationForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('announcements').insert({ title: form.get('title').trim(), body: form.get('body').trim(), audience_role: form.get('audience'), created_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Announcement published.'); loadNotifications(); });
$('documentTypeForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: ranks } = await supabase.from('document_types').select('sequence_order').order('sequence_order', { ascending: false }).limit(1); const { error } = await supabase.from('document_types').insert({ name: form.get('name').trim(), applies_to: form.get('applies_to'), is_required: form.get('is_required') === 'on', sequence_order: (ranks?.[0]?.sequence_order || 0) + 10 }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Document type added.'); loadSettings(); });
$('lenderBranchForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('lender_branches').insert({ lender_id: form.get('lender_id'), name: form.get('name').trim(), created_by: auth.user.id, updated_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Branch added.'); loadSettings(); });
$('consultancyForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.target); const { data: auth } = await supabase.auth.getUser(); const { error } = await supabase.from('consultancies').insert({ name: form.get('name').trim(), created_by: auth.user.id, updated_by: auth.user.id }); if (error) return showToast(error.message, true); event.target.reset(); showToast('Consultancy added.'); loadSettings(); });
requireAdmin().then(loadActive).catch((error) => { document.body.innerHTML = `<main style="padding:48px;font-family:Inter,sans-serif"><h1>Access unavailable</h1><p>${esc(error.message)}</p><a href="../../authentication/public/login.html">Go to sign in</a></main>`; });
