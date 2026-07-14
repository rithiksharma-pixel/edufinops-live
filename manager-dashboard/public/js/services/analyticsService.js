// =========================================================
// SERVICE LAYER — Manager Dashboard analytics
// Manager's RLS already scopes leads/deals to their reporting team
// (verified when Lead Management's RLS was built) — every query here
// just fetches what RLS already allows and aggregates client-side.
//
// SCALING NOTE: client-side aggregation is fine at a team's scale
// (tens of RMs, hundreds of leads) but won't hold up at the "1M
// leads" scale mentioned in the original brief — the future Reporting
// application should replace this with real SQL views/materialized
// aggregates rather than fetching raw rows and summing in the browser.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export async function getTeamFunnel() {
  const { data, error } = await supabase
    .from('leads')
    .select('current_stage_id, lead_stages ( name, sequence_order )')
    .eq('is_deleted', false);
  if (error) throw error;

  const counts = {};
  data.forEach((l) => {
    const name = l.lead_stages?.name || 'Unknown';
    counts[name] = (counts[name] || 0) + 1;
  });
  // Sort by the stage's actual sequence, not alphabetically
  const order = {};
  data.forEach((l) => { if (l.lead_stages) order[l.lead_stages.name] = l.lead_stages.sequence_order; });
  return Object.entries(counts)
    .sort((a, b) => (order[a[0]] ?? 999) - (order[b[0]] ?? 999))
    .map(([name, count]) => ({ name, count }));
}

export async function getRmPerformance() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, assigned_rm_id, loan_amount_requested, next_follow_up_at, assigned_rm:users!leads_assigned_rm_id_fkey(full_name)')
    .eq('is_deleted', false)
    .not('assigned_rm_id', 'is', null);
  if (error) throw error;

  const { data: deals, error: dealsError } = await supabase
    .from('deals')
    .select('id, total_disbursed_amount, current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name), leads!inner(assigned_rm_id)')
    .eq('is_deleted', false);
  if (dealsError) throw dealsError;

  const byRm = {};
  leads.forEach((l) => {
    const rmId = l.assigned_rm_id;
    if (!byRm[rmId]) byRm[rmId] = { name: l.assigned_rm?.full_name || 'Unknown', leadCount: 0, overdueCount: 0, disbursedAmount: 0, dealCount: 0 };
    byRm[rmId].leadCount += 1;
    if (l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date()) byRm[rmId].overdueCount += 1;
  });
  deals.forEach((d) => {
    const rmId = d.leads?.assigned_rm_id;
    if (!rmId || !byRm[rmId]) return;
    byRm[rmId].dealCount += 1;
    if (d.current_deal_stage?.name === 'Closed Won') byRm[rmId].disbursedAmount += Number(d.total_disbursed_amount || 0);
  });

  return Object.values(byRm).sort((a, b) => b.leadCount - a.leadCount);
}

export async function getLenderBreakdown() {
  const { data, error } = await supabase
    .from('deals')
    .select(`
      id, is_on_hold, is_rejected, total_disbursed_amount,
      lenders ( name ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name )
    `)
    .eq('is_deleted', false);
  if (error) throw error;

  const byLender = {};
  data.forEach((d) => {
    const name = d.lenders?.name || 'Unknown';
    if (!byLender[name]) byLender[name] = { name, dealCount: 0, stageCounts: {}, disbursedAmount: 0 };
    byLender[name].dealCount += 1;
    const stageName = d.current_deal_stage?.name || 'Unknown';
    byLender[name].stageCounts[stageName] = (byLender[name].stageCounts[stageName] || 0) + 1;
    if (stageName === 'Closed Won') byLender[name].disbursedAmount += Number(d.total_disbursed_amount || 0);
  });
  return Object.values(byLender).sort((a, b) => b.dealCount - a.dealCount);
}

// How many days a deal can sit in a stage before it's flagged as stuck.
// V1: hardcoded per-stage default. Revisit as an admin-configurable
// setting once there's a Settings surface for it.
const STAGE_TAT_THRESHOLD_DAYS = {
  'Bank Prospect': 7,
  Login: 5,
  Sanction: 10,
  PF: 5,
  Disbursement: 7,
};

/**
 * "Needs attention" = overdue follow-up, a deal on hold/rejected, a deal
 * that's overstayed its current stage's TAT threshold, or an overdue task.
 * Same heuristic as Lender Pipeline's dashboard, applied here across the
 * whole team instead of one bank.
 */
export async function getAttentionSummary() {
  const { data: leadsData, error: leadsError } = await supabase
    .from('leads')
    .select('id, student_name, next_follow_up_at, assigned_rm:users!leads_assigned_rm_id_fkey(full_name)')
    .eq('is_deleted', false);
  if (leadsError) throw leadsError;

  const { data: dealsData, error: dealsError } = await supabase
    .from('deals')
    .select('id, is_on_hold, is_rejected, created_at, lead_id, leads(student_name), current_deal_stage_id, current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name)')
    .eq('is_deleted', false);
  if (dealsError) throw dealsError;

  const { data: stageEvents, error: eventsError } = await supabase
    .from('deal_events')
    .select('deal_id, to_stage_id, created_at')
    .not('to_stage_id', 'is', null)
    .order('created_at', { ascending: false });
  if (eventsError) throw eventsError;

  const { data: overdueTasksData, error: tasksError } = await supabase
    .from('tasks')
    .select('id, title, due_date, leads(student_name), assigned_to:users!tasks_assigned_to_user_id_fkey(full_name)')
    .eq('is_deleted', false)
    .eq('is_completed', false)
    .lt('due_date', new Date().toISOString().slice(0, 10));
  if (tasksError) throw tasksError;

  const now = Date.now();

  // Latest event that moved each deal INTO its current stage — the clock
  // for "how long has it been stuck here" starts there, not at last-updated
  // (which also bumps on unrelated edits like hold/release).
  const enteredCurrentStageAt = {};
  for (const ev of stageEvents) {
    if (enteredCurrentStageAt[ev.deal_id]) continue; // already have the newest (rows are DESC)
    enteredCurrentStageAt[ev.deal_id] = ev;
  }

  const overdueLeads = leadsData.filter((l) => l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() < now);

  const tatBreachedDeals = dealsData.filter((d) => {
    if (d.is_on_hold || d.is_rejected) return false;
    const stageName = d.current_deal_stage?.name;
    if (!stageName || !STAGE_TAT_THRESHOLD_DAYS[stageName]) return false;
    const enteredAt = enteredCurrentStageAt[d.id]?.created_at || d.created_at;
    const daysInStage = (now - new Date(enteredAt).getTime()) / (24 * 60 * 60 * 1000);
    return daysInStage > STAGE_TAT_THRESHOLD_DAYS[stageName];
  });

  const flaggedDeals = dealsData.filter((d) => d.is_on_hold || d.is_rejected || tatBreachedDeals.includes(d));
  const onTrackCount = leadsData.length - overdueLeads.length;

  return {
    overdueLeads: overdueLeads.map((l) => ({ name: l.student_name, rm: l.assigned_rm?.full_name, dueAt: l.next_follow_up_at })),
    flaggedDeals: flaggedDeals.map((d) => ({
      name: d.leads?.student_name,
      reason: d.is_rejected ? 'Rejected' : d.is_on_hold ? 'On hold' : `Overstayed ${d.current_deal_stage?.name} (${STAGE_TAT_THRESHOLD_DAYS[d.current_deal_stage?.name]}d TAT)`,
    })),
    overdueTasks: overdueTasksData.map((t) => ({ title: t.title, dueDate: t.due_date, student: t.leads?.student_name, owner: t.assigned_to?.full_name })),
    onTrackCount,
    totalLeads: leadsData.length,
  };
}

/**
 * Turn-around-time between consecutive deal stages, computed purely from
 * deal_events timestamps (every stage change is already logged there —
 * no new tracking needed). Returns per-transition averages plus the
 * slowest individual transitions, each with its remarks if one was left.
 */
export async function getTatAnalysis() {
  const { data, error } = await supabase
    .from('deal_events')
    .select('deal_id, to_stage_id, created_at, remarks, to_stage:deal_stages!deal_events_to_stage_id_fkey(name), deals(leads(student_name))')
    .not('to_stage_id', 'is', null)
    .order('deal_id', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;

  const byDeal = {};
  data.forEach((ev) => { (byDeal[ev.deal_id] ??= []).push(ev); });

  const transitions = [];
  Object.values(byDeal).forEach((events) => {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      const days = (new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime()) / (24 * 60 * 60 * 1000);
      transitions.push({
        label: `${prev.to_stage?.name || '–'} → ${curr.to_stage?.name || '–'}`,
        days,
        student: curr.deals?.leads?.student_name,
        remarks: curr.remarks,
      });
    }
  });

  const byLabel = {};
  transitions.forEach((t) => { (byLabel[t.label] ??= []).push(t.days); });
  const averages = Object.entries(byLabel)
    .map(([label, values]) => ({ label, avgDays: values.reduce((a, b) => a + b, 0) / values.length, count: values.length }))
    .sort((a, b) => b.avgDays - a.avgDays);

  const worstOffenders = [...transitions].sort((a, b) => b.days - a.days).slice(0, 10);

  return { averages, worstOffenders };
}

export async function getDailyBusiness() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const { data: leadsToday, error: leadsError } = await supabase
    .from('leads')
    .select('id')
    .eq('is_deleted', false)
    .gte('created_at', startOfToday.toISOString());
  if (leadsError) throw leadsError;

  const { data: disbursementsToday, error: disbError } = await supabase
    .from('disbursements')
    .select('amount')
    .eq('is_deleted', false)
    .gte('created_at', startOfToday.toISOString());
  if (disbError) throw disbError;

  return {
    newLeadsToday: leadsToday.length,
    disbursementsToday: disbursementsToday.length,
    disbursedAmountToday: disbursementsToday.reduce((sum, d) => sum + Number(d.amount), 0),
  };
}
