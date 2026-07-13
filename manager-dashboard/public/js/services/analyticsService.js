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

/**
 * "Needs attention" = overdue follow-up, or a deal on hold/rejected, or
 * a deal with no movement in 7+ days. Same heuristic as Lender Pipeline's
 * dashboard, applied here across the whole team instead of one bank.
 */
export async function getAttentionSummary() {
  const { data: leadsData, error: leadsError } = await supabase
    .from('leads')
    .select('id, student_name, next_follow_up_at, assigned_rm:users!leads_assigned_rm_id_fkey(full_name)')
    .eq('is_deleted', false);
  if (leadsError) throw leadsError;

  const { data: dealsData, error: dealsError } = await supabase
    .from('deals')
    .select('id, is_on_hold, is_rejected, updated_at, lead_id, leads(student_name), current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name)')
    .eq('is_deleted', false);
  if (dealsError) throw dealsError;

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const overdueLeads = leadsData.filter((l) => l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() < now);
  const flaggedDeals = dealsData.filter((d) => {
    const stuck = new Date(d.updated_at).getTime() < sevenDaysAgo && d.current_deal_stage?.name !== 'Closed Won';
    return d.is_on_hold || d.is_rejected || stuck;
  });
  const onTrackCount = leadsData.length - overdueLeads.length;

  return {
    overdueLeads: overdueLeads.map((l) => ({ name: l.student_name, rm: l.assigned_rm?.full_name, dueAt: l.next_follow_up_at })),
    flaggedDeals: flaggedDeals.map((d) => ({ name: d.leads?.student_name, reason: d.is_rejected ? 'Rejected' : d.is_on_hold ? 'On hold' : 'No movement in 7+ days' })),
    onTrackCount,
    totalLeads: leadsData.length,
  };
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
