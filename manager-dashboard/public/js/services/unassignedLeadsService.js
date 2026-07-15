// =========================================================
// SERVICE LAYER — Unassigned leads (Manager Dashboard)
//
// Consultants/BD create leads via consultant-portal with no
// assigned_rm_id (and no assigned_manager_id either — that column
// only gets set for leads a Manager creates directly). Until this
// query's RLS fix, NO manager could see those rows at all: the old
// leads_select_manager policy only matched
// (assigned_manager_id = auth.uid()) OR rm_reports_to_current_manager(assigned_rm_id),
// and neither clause can ever match a row where both are NULL.
//
// See deployment/010_unassigned_leads_manager_visibility_migration.sql
// for the fix — it adds an explicit "genuinely unclaimed"
// (assigned_rm_id IS NULL AND assigned_manager_id IS NULL) branch so
// any Manager/Associate Team Manager can see and claim leads from
// this shared intake pool. Once assigned, the lead falls under the
// normal per-team RLS scoping like every other lead — this file
// never needs its own client-side filtering, same as every other
// service on this dashboard.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

const UNASSIGNED_LEADS_SELECT = `
  id, student_name, loan_amount_requested, currency, created_at,
  lead_sources ( name ),
  consultancies ( name ),
  consultancy_other_name
`;

export async function getUnassignedLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select(UNASSIGNED_LEADS_SELECT)
    .eq('is_deleted', false)
    .is('assigned_rm_id', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}
