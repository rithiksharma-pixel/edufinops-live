// =========================================================
// SERVICE LAYER — RM Workspace dashboard views
// RLS already scopes leads/deals/documents to "assigned to me" for
// the RM role — every query here relies on that, never re-filters
// client-side for security (only for display grouping).
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import { fetchAll, fetchAllResult } from '../../../../shared/js/fetchAll.js';
import { getTatThresholds } from '../../../../shared/js/tatThresholds.js';

const LEAD_SELECT = `
  id, student_name, student_phone, course_name, university_name,
  loan_amount_requested, currency, next_follow_up_at, created_at,
  lead_stages ( name, sequence_order )
`;

export async function getAssignedLeads() {
  return fetchAll(
    () => supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('is_deleted', false)
      .order('next_follow_up_at', { ascending: true, nullsFirst: false })
  );
}

export async function getTodaysFollowUps() {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return fetchAll(
    () => supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('is_deleted', false)
      .lte('next_follow_up_at', endOfToday.toISOString())
      .not('next_follow_up_at', 'is', null)
      .order('next_follow_up_at', { ascending: true })
  );
}

export async function getNewLeads() {
  const data = await fetchAll(
    () => supabase
      .from('leads')
      .select(LEAD_SELECT)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false }),
    { tiebreak: 'id', ascending: false }
  );
  // "New" = still at the very first stage (untouched since creation).
  // Filtered client-side on sequence_order since it's a small, already-
  // RLS-scoped result set, not worth a second round trip for.
  const minOrder = Math.min(...data.map((l) => l.lead_stages?.sequence_order ?? Infinity));
  return data.filter((l) => l.lead_stages?.sequence_order === minOrder);
}

export async function getDocumentsPending() {
  const { data, error } = await fetchAllResult(() => supabase
    .from('documents')
    .select(`
      id, file_name, uploaded_at,
      document_types ( name ),
      leads ( id, student_name )
    `)
    .eq('verification_status', 'Pending Review')
    .eq('is_deleted', false)
    .order('uploaded_at', { ascending: true }));
  if (error) throw error;
  return data;
}

export async function getMyTatBreachedDeals() {
  const thresholds = await getTatThresholds(supabase);

  const { data: dealsData, error: dealsError } = await fetchAllResult(() => supabase
    .from('deals')
    .select('id, is_on_hold, is_rejected, created_at, leads(id, student_name), current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey(name)')
    .eq('is_deleted', false));
  if (dealsError) throw dealsError;

  const { data: stageEvents, error: eventsError } = await fetchAllResult(() => supabase
    .from('deal_events')
    .select('deal_id, to_stage_id, created_at')
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
