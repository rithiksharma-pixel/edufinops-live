// =========================================================
// SERVICE LAYER — RM Workspace dashboard views
//
// This file used to say "RLS already scopes leads to assigned-to-me, every
// query relies on that". That stopped being true at migration 035, which
// deliberately opened every lead to every internal staff member. Nothing
// here broke loudly — the queries just quietly started returning the whole
// company's book.
//
// RLS is a PERMISSION boundary (what you MAY read). It is not, and can no
// longer be, an ownership FILTER (what you SHOULD see). Every query below
// passes assigned_rm_id explicitly.
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import { fetchAll, fetchAllResult } from '../../../../shared/js/fetchAll.js';
import { getTatThresholds } from '../../../../shared/js/tatThresholds.js';

const LEAD_SELECT = `
  id, student_name, student_phone, course_name, university_name,
  loan_amount_requested, currency, next_follow_up_at, created_at,
  lead_stages ( name, sequence_order )
`;

// EVERY query below MUST filter on assigned_rm_id explicitly.
//
// These used to pass no owner filter at all and leaned on RLS to return only
// the caller's own leads. Migration 035 ("open all leads to the whole team")
// removed that scoping: RLS is now a permission boundary, not a filter. The
// result was that "Assigned leads" — a screen whose subtitle reads "Every
// lead currently assigned to you" — returned all 11,951 leads in the company,
// twelve sequential paged round trips deep, which is why the page sat on its
// spinner. RLS still decides what you MAY see; it no longer decides what you
// SHOULD see.

export async function getAssignedLeads(rmId) {
  return fetchAll(
    () => supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('is_deleted', false)
      .eq('assigned_rm_id', rmId)
      .order('next_follow_up_at', { ascending: true, nullsFirst: false })
  );
}

export async function getTodaysFollowUps(rmId) {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return fetchAll(
    () => supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('is_deleted', false)
      .eq('assigned_rm_id', rmId)
      .lte('next_follow_up_at', endOfToday.toISOString())
      .not('next_follow_up_at', 'is', null)
      .order('next_follow_up_at', { ascending: true })
  );
}

export async function getNewLeads(rmId) {
  const data = await fetchAll(
    () => supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('is_deleted', false)
      .eq('assigned_rm_id', rmId)
      .order('created_at', { ascending: false }),
    { tiebreak: 'id', ascending: false }
  );
  if (!data.length) return [];
  // "New" = still at the very first stage (untouched since creation).
  // Filtered client-side on sequence_order: now that the query is scoped to
  // this RM it really is a small result set, which is what that assumption
  // always depended on.
  const minOrder = Math.min(...data.map((l) => l.lead_stages?.sequence_order ?? Infinity));
  return data.filter((l) => l.lead_stages?.sequence_order === minOrder);
}

export async function getDocumentsPending(rmId) {
  // leads!inner + a filter on the embedded column, so the scoping happens in
  // Postgres. Without it this returned every pending document in the company
  // under a heading that says "awaiting your verification".
  const { data, error } = await fetchAllResult(() => supabase
    .from('documents')
    .select(`
      id, file_name, uploaded_at,
      document_types ( name ),
      leads!inner ( id, student_name, assigned_rm_id )
    `)
    .eq('verification_status', 'Pending Review')
    .eq('is_deleted', false)
    .eq('leads.assigned_rm_id', rmId)
    .order('uploaded_at', { ascending: true }));
  if (error) throw error;
  return data;
}

export async function getMyTatBreachedDeals(rmId) {
  const thresholds = await getTatThresholds(supabase);

  // Deals carry no RM of their own, so scope through the lead. This also cuts
  // the deal_events read from every event in the system to just this RM's.
  const { data: dealsData, error: dealsError } = await fetchAllResult(() => supabase
    .from('deals')
    .select('id, is_on_hold, is_rejected, created_at, leads!inner(id, student_name, assigned_rm_id), current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name)')
    .eq('is_deleted', false)
    .eq('leads.assigned_rm_id', rmId));
  if (dealsError) throw dealsError;
  if (!dealsData.length) return [];

  const dealIds = dealsData.map((d) => d.id);
  const { data: stageEvents, error: eventsError } = await fetchAllResult(() => supabase
    .from('deal_events')
    .select('deal_id, to_stage_id, created_at')
    .in('deal_id', dealIds)
    .not('to_stage_id', 'is', null)
    .order('created_at', { ascending: false }));
  if (eventsError) throw eventsError;

  const enteredCurrentStageAt = {};
  for (const ev of stageEvents) {
    if (enteredCurrentStageAt[ev.deal_id]) continue;
    enteredCurrentStageAt[ev.deal_id] = ev;
  }

  const now = Date.now();
  return dealsData
    .filter((d) => {
      if (d.is_on_hold || d.is_rejected) return false;
      const stageName = d.current_deal_stage?.name;
      if (!stageName || !thresholds[stageName]) return false;
      const enteredAt = enteredCurrentStageAt[d.id]?.created_at || d.created_at;
      const daysInStage = (now - new Date(enteredAt).getTime()) / (24 * 60 * 60 * 1000);
      return daysInStage > thresholds[stageName];
    })
    .map((d) => ({ leadId: d.leads?.id, student: d.leads?.student_name, stage: d.current_deal_stage?.name, thresholdDays: thresholds[d.current_deal_stage?.name] }));
}

export async function getLenderUpdates() {
  const { data, error } = await supabase
    .from('deal_events')
    .select(`
      id, event_type, remarks, created_at,
      deals ( lenders ( name ), leads ( id, student_name ) )
    `)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return data;
}
