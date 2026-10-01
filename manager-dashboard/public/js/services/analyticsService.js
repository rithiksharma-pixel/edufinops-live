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
import { leadFunnel } from '../../../../shared/js/leadFunnel.js';
import { fetchAll, fetchAllResult } from '../../../../shared/js/fetchAll.js';
import { getTatThresholds } from '../../../../shared/js/tatThresholds.js';
// CALL_STATUS_OPTIONS is owned by Lead Management's leadService.js (the
// only place calls are actually logged) — imported rather than
// re-declared so the two lists can never drift apart.
import { CALL_STATUS_OPTIONS, CONNECTED_DISPOSITIONS } from '../../../../lead-management/public/js/services/leadService.js';

/**
 * @param {object} period  from shared/js/periodPicker.js. The funnel is a
 *   cohort: the leads CREATED in the period, and how far each has got since.
 */
export async function getTeamFunnel(period) {
  // Paged: PostgREST's 1000-row cap made every stage count in this funnel
  // under-report once the team passed 1000 leads.
  const data = await fetchAll(
    () => {
      let query = supabase
        .from('leads')
        .select('id, lost_reason_id, login_date, sanction_date, pf_date, disbursed_date, lead_stages ( name, sequence_order )')
        .eq('is_deleted', false);
      if (period?.fromTs) query = query.gte('created_at', period.fromTs);
      if (period?.toTs) query = query.lte('created_at', period.toTs);
      return query;
    }
  );
  // Reached, not current: see shared/js/leadFunnel.js.
  return leadFunnel(data);
}

/** Grouping options for the performance table. */
export const PERF_GROUPS = { owner: 'RM', team: 'Team', manager: 'Manager' };

/**
 * Performance per owner / team / manager for a date window.
 *
 * One RPC. This used to pull EVERY lead and EVERY deal into the browser and
 * reduce them client-side — two paged fetches, 24+ sequential round trips, to
 * produce about thirty rows.
 *
 * Each metric counts against its OWN date: leads by created_at, logins by
 * login_date, sanctions by sanction_date and so on. "Logins this week" means
 * leads that logged in this week, not leads created this week that happen to
 * have a login. Overdue is a right-now measure and ignores the window.
 *
 * @param {?string} from ISO date, null for all time
 * @param {?string} to   ISO date, inclusive
 * @param {'owner'|'team'|'manager'} groupBy
 */
export async function getRmPerformance(from = null, to = null, groupBy = 'owner') {
  const { data, error } = await supabase.rpc('rm_performance', {
    p_from: from || null,
    p_to: to || null,
    p_group_by: PERF_GROUPS[groupBy] ? groupBy : 'owner',
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.group_id,
    name: r.group_name,
    leadCount: Number(r.leads),
    overdueCount: Number(r.overdue),
    logins: Number(r.logins),
    sanctions: Number(r.sanctions),
    pf: Number(r.pf),
    disbursed: Number(r.disbursed),
    disbursedAmount: Number(r.disbursed_amount),
    referrals: Number(r.referrals),
    pfFromReferrals: Number(r.pf_from_referrals),
  }));
}

// Calendar week starting Monday 00:00 local time — duplicated per app
// rather than shared, matching this codebase's existing pattern of each
// app owning its own copy of small date-window helpers.
export function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Per-RM call volume + connect rate for the period, keyed
 * by the user id who logged the call (created_by) — i.e. whose activity
 * it actually is, not just whichever RM the lead happens to be assigned
 * to. RLS's lead_events_select policy (can_view_lead) already scopes
 * visible rows to leads this manager's team can see, so no extra
 * team-membership filtering is needed client-side.
 *
 * "All time" falls back to the current calendar week: every call ever logged
 * is tens of thousands of rows to page through for one column, and a
 * lifetime call count says nothing about how someone is working now.
 */
export async function getRmCallStats(period) {
  const bounded = period && !period.isAll;
  const since = bounded ? period.fromTs : startOfWeek().toISOString();
  const until = bounded ? period.toTs : null;
  const data = await fetchAll(
    () => {
      let query = supabase
        .from('lead_events')
        .select('id, event_type, created_by')
        .in('event_type', CALL_STATUS_OPTIONS)
        .eq('is_deleted', false);
      if (since) query = query.gte('created_at', since);
      if (until) query = query.lte('created_at', until);
      return query;
    }
  );

  const byRm = {};
  data.forEach((ev) => {
    if (!ev.created_by) return;
    if (!byRm[ev.created_by]) byRm[ev.created_by] = { callCount: 0, connectedCount: 0 };
    byRm[ev.created_by].callCount += 1;
    if (CONNECTED_DISPOSITIONS.includes(ev.event_type)) byRm[ev.created_by].connectedCount += 1;
  });
  return byRm;
}

/**
 * Per-lender funnel from lender_funnel() (deployment/068): each case counts
 * at every stage it REACHED, from its history, not only where it sits now.
 * The old version counted current stage only, so "Login" left out every
 * case that had logged in and moved on, Closed Won appeared in no column,
 * and disbursed value counted Closed Won cases only.
 */
export async function getLenderBreakdown() {
  const { data, error } = await supabase.rpc('lender_funnel');
  if (error) throw error;
  return (data || [])
    .map((r) => ({
      name: r.lender_name,
      cases: Number(r.cases), login: Number(r.reached_login), sanction: Number(r.reached_sanction),
      pf: Number(r.reached_pf), disbursement: Number(r.reached_disbursement),
      open: Number(r.open_cases), declined: Number(r.declined), disbursedAmount: Number(r.disbursed_amount),
    }))
    .sort((a, b) => b.login - a.login || b.cases - a.cases);
}

/**
 * What each lender did IN a period: cases opened, and logins, sanctions, PF
 * and disbursements dated inside it. This is activity, not a funnel — a
 * sanction in September may belong to a case that logged in during August —
 * so the stages are not shares of one another the way lender_funnel()'s are.
 *
 * Milestones come from v_stage_milestones, the same rows milestone_counts()
 * adds up, so the "All lenders" row here equals the headline figures for the
 * same period.
 */
export async function getLenderActivity(period) {
  const [milestones, deals] = await Promise.all([
    fetchAll(
      () => {
        let query = supabase.from('v_stage_milestones').select('deal_id, lender, milestone, amount');
        if (period.from) query = query.gte('event_date', period.from);
        if (period.to) query = query.lte('event_date', period.to);
        return query.order('milestone', { ascending: true });
      },
      { tiebreak: 'deal_id' }
    ),
    fetchAll(
      () => {
        let query = supabase.from('deals').select('id, lenders ( name )').eq('is_deleted', false);
        if (period.fromTs) query = query.gte('created_at', period.fromTs);
        if (period.toTs) query = query.lte('created_at', period.toTs);
        return query;
      }
    ),
  ]);

  const byLender = new Map();
  const row = (name) => {
    const key = name || '(no lender)';
    if (!byLender.has(key)) {
      byLender.set(key, { name: key, cases: 0, login: 0, sanction: 0, pf: 0, disbursement: 0, declined: null, disbursedAmount: 0 });
    }
    return byLender.get(key);
  };
  deals.forEach((d) => { row(d.lenders?.name).cases += 1; });
  milestones.forEach((m) => {
    const r = row(m.lender);
    if (m.milestone === 'Login') r.login += 1;
    else if (m.milestone === 'Sanction') r.sanction += 1;
    else if (m.milestone.startsWith('PF')) r.pf += 1;
    else if (m.milestone === 'Disbursement') { r.disbursement += 1; r.disbursedAmount += Number(m.amount || 0); }
  });
  return [...byLender.values()].sort((a, b) => b.login - a.login || b.cases - a.cases);
}

/**
 * "Needs attention" = overdue follow-up, a deal on hold/rejected, a deal
 * that's overstayed its current stage's TAT threshold, or an overdue task.
 * Same heuristic as Lender Pipeline's dashboard, applied here across the
 * whole team instead of one bank.
 */
export async function getAttentionSummary() {
  const thresholds = await getTatThresholds(supabase);

  // All paged — `totalLeads` and `onTrackCount` are rendered as headline
  // numbers, so a 1000-row truncation here showed a wrong pipeline size.
  const leadsData = await fetchAll(
    () => supabase
      .from('leads')
      .select('id, student_name, next_follow_up_at, assigned_rm:users!leads_assigned_rm_id_fkey(full_name)')
      .eq('is_deleted', false)
  );

  const dealsData = await fetchAll(
    () => supabase
      .from('deals')
      .select('id, is_on_hold, is_rejected, created_at, lead_id, leads(student_name), current_deal_stage_id, current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name)')
      .eq('is_deleted', false)
  );

  const stageEvents = await fetchAll(
    () => supabase
      .from('deal_events')
      .select('id, deal_id, to_stage_id, created_at')
      .not('to_stage_id', 'is', null)
      .order('created_at', { ascending: false }),
    { tiebreak: 'id', ascending: false }
  );

  const overdueTasksData = await fetchAll(
    () => supabase
      .from('tasks')
      .select('id, title, due_date, leads(id, student_name), assigned_to:users!tasks_assigned_to_user_id_fkey(full_name)')
      .eq('is_deleted', false)
      .eq('is_completed', false)
      .lt('due_date', new Date().toISOString().slice(0, 10))
  );

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
    if (!stageName || !thresholds[stageName]) return false;
    const enteredAt = enteredCurrentStageAt[d.id]?.created_at || d.created_at;
    const daysInStage = (now - new Date(enteredAt).getTime()) / (24 * 60 * 60 * 1000);
    return daysInStage > thresholds[stageName];
  });

  const flaggedDeals = dealsData.filter((d) => d.is_on_hold || d.is_rejected || tatBreachedDeals.includes(d));
  const onTrackCount = leadsData.length - overdueLeads.length;

  return {
    overdueLeads: overdueLeads.map((l) => ({ leadId: l.id, name: l.student_name, rm: l.assigned_rm?.full_name, dueAt: l.next_follow_up_at })),
    flaggedDeals: flaggedDeals.map((d) => ({
      leadId: d.lead_id,
      name: d.leads?.student_name,
      reason: d.is_rejected ? 'Rejected' : d.is_on_hold ? 'On hold' : `Overstayed ${d.current_deal_stage?.name} (${thresholds[d.current_deal_stage?.name]}d TAT)`,
    })),
    overdueTasks: overdueTasksData.map((t) => ({ leadId: t.leads?.id, title: t.title, dueDate: t.due_date, student: t.leads?.student_name, owner: t.assigned_to?.full_name })),
    onTrackCount,
    totalLeads: leadsData.length,
  };
}

/**
 * Turn-around-time between consecutive deal stages, computed purely from
 * deal_events timestamps (every stage change is already logged there —
 * no new tracking needed). Returns per-transition averages plus the
 * slowest individual transitions, each with its remarks if one was left.
 *
 * A transition belongs to the period it COMPLETED in. The previous event is
 * still needed to time it, so every event is read and the filter is applied
 * to the finished transitions rather than to the query.
 *
 * @param {?(value: string) => boolean} inPeriod  from periodTester()
 */
export async function getTatAnalysis(inPeriod = null) {
  const { data, error } = await fetchAllResult(() => supabase
    .from('deal_events')
    .select('deal_id, to_stage_id, created_at, remarks, to_stage:deal_stages!deal_events_to_stage_id_fkey(name), deals(leads(student_name))')
    .not('to_stage_id', 'is', null)
    .order('deal_id', { ascending: true })
    .order('created_at', { ascending: true }));
  if (error) throw error;

  const byDeal = {};
  data.forEach((ev) => { (byDeal[ev.deal_id] ??= []).push(ev); });

  const transitions = [];
  Object.values(byDeal).forEach((events) => {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      if (inPeriod && !inPeriod(curr.created_at)) continue;
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

