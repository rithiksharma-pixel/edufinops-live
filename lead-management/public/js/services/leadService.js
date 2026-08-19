// =========================================================
// SERVICE LAYER — Leads
// Presentation code (components/app.js) calls only these functions.
// Nothing outside this file constructs a Supabase query for `leads`.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

const LEAD_LIST_SELECT = `
  id, student_name, student_phone, student_email,
  course_name, university_name, loan_amount_requested, currency,
  next_follow_up_at, last_activity_at,
  current_stage_id, assigned_rm_id,
  consultancy_other_name, bd_name,
  lead_stages ( name, color ),
  consultancies ( name ),
  assigned_rm:users!leads_assigned_rm_id_fkey ( full_name )
`;

/**
 * Every column the "Date basis" filter may use. A whitelist, because the value
 * is interpolated into a query as a column name — the <select> is a UI
 * convenience, not a security boundary. Keep in sync with the dropdown in
 * index.html and with lead_stage_counts()'s CASE in migration 045b.
 */
export const DATE_FIELDS = new Set([
  'created_at', 'updated_at',
  'login_date', 'sanction_date', 'pf_date', 'disbursed_date',
]);

/** Label for each, used in the active-filter trail above the table. */
export const DATE_FIELD_LABELS = {
  created_at: 'Created',
  updated_at: 'Updated',
  login_date: 'Login',
  sanction_date: 'Sanction',
  pf_date: 'PF',
  disbursed_date: 'Disbursed',
};

/**
 * Applies the shared filter set (used by both listLeads and countLeads,
 * so a Smart View's tab count always matches what the list actually
 * shows once you click it) to a `leads` query builder in place.
 */
function applyLeadFilters(query, { stageId, sourceId, rmId, search, dateField, dateFrom, dateTo, priority, overdueOnly } = {}) {
  if (stageId) query = query.eq('current_stage_id', stageId);
  if (sourceId) query = query.eq('lead_source_id', sourceId);
  if (rmId) query = query.eq('assigned_rm_id', rmId);
  if (priority) query = query.eq('priority', priority);
  if (overdueOnly) query = query.lt('next_follow_up_at', new Date().toISOString());
  if (search) {
    // Strip characters that are grammar in a PostgREST or() filter (comma,
    // parens, quotes, backslash) and the ilike wildcards — otherwise a phone
    // typed as "(555) 123-4567" 400s the request and surfaces as a generic
    // "Could not load leads". None of these are meaningful in a name/phone
    // search anyway.
    const s = search.replace(/[,()"\\%_]/g, ' ').trim();
    if (s) query = query.or(`student_name.ilike.%${s}%,student_phone.ilike.%${s}%`);
  }

  // Date-range filter. Still a whitelist — the value comes from a <select>,
  // but it reaches a query builder, so it is never trusted as a column name.
  //
  // The four milestone columns are plain `date` on leads, denormalised from
  // the per-deal detail tables by trigger (045). Timestamps need an
  // end-of-day bound to make `To` inclusive; dates compare directly.
  if (DATE_FIELDS.has(dateField) && dateField.endsWith('_date')) {
    if (dateFrom) query = query.gte(dateField, dateFrom);
    if (dateTo) query = query.lte(dateField, dateTo);
  } else {
    const field = dateField === 'updated_at' ? 'updated_at' : 'created_at';
    if (dateFrom) query = query.gte(field, `${dateFrom}T00:00:00`);
    if (dateTo) query = query.lte(field, `${dateTo}T23:59:59.999`);
  }

  return query;
}

/**
 * Fetch leads with optional filters. RLS already restricts rows to what
 * the current user's role is allowed to see — this function does not
 * need to (and must not) apply its own role-based scoping.
 */
export const LEAD_PAGE_SIZE = 100;

/**
 * ONE page of leads plus the true total.
 *
 * This used to fetchAll() the entire result set. That fixed PostgREST's silent
 * 1000-row truncation, but at 11,900 leads it meant twelve SEQUENTIAL round
 * trips and several MB of JSON on every render and every filter change — the
 * single biggest cause of the app feeling slow. The database was never the
 * problem: the same query server-side runs in ~19ms.
 *
 * `count: 'exact'` gives the real total in the same request, so the count
 * strip and the pager stay honest without a second call. created_at is not
 * unique, so `id` is a tiebreaker — without it a row can repeat on one page
 * and vanish from the next.
 *
 * @returns {Promise<{rows: Array, total: number}>}
 */
export async function listLeads(filters = {}, { limit = LEAD_PAGE_SIZE, offset = 0 } = {}) {
  const { data, error, count } = await applyLeadFilters(
    supabase
      .from('leads')
      .select(LEAD_LIST_SELECT, { count: 'exact' })
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }),
    filters
  ).range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

/** Same filter set as listLeads, head-only count — powers Smart View tab badges. */
export async function countLeads(filters = {}) {
  let query = supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('is_deleted', false);

  query = applyLeadFilters(query, filters);

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/**
 * Stage counts for the funnel summary row. One query, grouped client-side
 * (Supabase JS doesn't do GROUP BY directly without a Postgres function;
 * for a table this size a client-side reduce is cheap and avoids an extra
 * RPC just for counting).
 *
 * Takes the same filters as listLeads MINUS the stage, so the cards agree
 * with the list below them. The stage is deliberately excluded: the cards
 * *are* the stage selector, so scoping them by the selected stage would zero
 * every other card and you could never click your way back out. Excluding it
 * means each card answers "how many would I get if I picked this instead",
 * which is the question the row exists to answer.
 */
export async function getStageCounts(filters = {}) {
  // One RPC that does the GROUP BY in Postgres and returns 8 rows.
  // This previously paged the whole leads table into the browser just to
  // count it — twelve round trips to produce eight numbers. Verified against
  // a direct group-by under the same RLS: all stages match exactly.
  const { data, error } = await supabase.rpc('lead_stage_counts', {
    p_source_id: filters.sourceId || null,
    p_rm_id: filters.rmId || null,
    p_priority: filters.priority || null,
    p_overdue_only: !!filters.overdueOnly,
    // Mirrors applyLeadFilters: the same characters are stripped so a phone
    // typed as "(555) 123-4567" behaves identically in both paths.
    p_search: (filters.search || '').replace(/[,()"\\%_]/g, ' ').trim() || null,
    p_date_field: DATE_FIELDS.has(filters.dateField) ? filters.dateField : 'created_at',
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
  });
  if (error) throw error;

  const counts = {};
  for (const row of data ?? []) counts[row.stage_id] = Number(row.leads);
  return counts;
}

export async function getLeadDetail(leadId) {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select(`
      *,
      lead_stages ( name, color ),
      lead_sources ( name, category ),
      lost_reason:lead_lost_reasons ( name ),
      assigned_rm:users!leads_assigned_rm_id_fkey ( full_name )
    `)
    .eq('id', leadId)
    .single();
  if (leadError) throw leadError;

  const { data: coApplicants, error: coError } = await supabase
    .from('co_applicants')
    .select('*')
    .eq('lead_id', leadId)
    .eq('is_deleted', false);
  if (coError) throw coError;

  return { lead, coApplicants };
}

/**
 * Fetches the EL Details extension data for a lead: university choices,
 * academic details, parent details, collateral, and both references.
 * Kept as one call so leadDrawer.js can fetch it alongside getLeadDetail
 * in the same Promise.all it already uses for stages/RMs/timeline.
 */
export async function getLeadExtendedDetail(leadId) {
  const [universities, academic, parents, collateral, references] = await Promise.all([
    supabase.from('lead_university_choices').select('*').eq('lead_id', leadId).eq('is_deleted', false).order('sequence_order'),
    supabase.from('lead_academic_details').select('*').eq('lead_id', leadId).eq('is_deleted', false).maybeSingle(),
    supabase.from('lead_parent_details').select('*').eq('lead_id', leadId).eq('is_deleted', false).maybeSingle(),
    supabase.from('lead_collateral_details').select('*').eq('lead_id', leadId).eq('is_deleted', false),
    supabase.from('lead_references').select('*').eq('lead_id', leadId).eq('is_deleted', false),
  ]);
  for (const r of [universities, academic, parents, collateral, references]) {
    if (r.error) throw r.error;
  }
  return {
    universities: universities.data,
    academic: academic.data,
    parents: parents.data,
    collateral: collateral.data,
    references: references.data,
  };
}

/** Personal ID + Loan Identification + Addresses + Alternate Contact + Employment — all plain leads columns. */
export async function updateApplicantDetails(leadId, fields) {
  const { error } = await supabase.from('leads').update(fields).eq('id', leadId);
  if (error) throw error;
}

export async function upsertUniversityChoices(leadId, choices, currentUserId) {
  // choices: [{ sequence_order, university_name }]. Replace-all is simplest
  // and correct here — there are at most 6 rows per lead, so a delete+insert
  // is cheap and avoids tracking which rows changed client-side.
  const { error: delError } = await supabase.from('lead_university_choices').delete().eq('lead_id', leadId);
  if (delError) throw delError;
  const rows = choices
    .filter((c) => c.university_name?.trim())
    .map((c) => ({ lead_id: leadId, sequence_order: c.sequence_order, university_name: c.university_name.trim(), created_by: currentUserId, updated_by: currentUserId }));
  if (rows.length === 0) return;
  const { error } = await supabase.from('lead_university_choices').insert(rows);
  if (error) throw error;
}

export async function upsertAcademicDetails(leadId, fields, currentUserId) {
  const { error } = await supabase
    .from('lead_academic_details')
    .upsert({ lead_id: leadId, ...fields, updated_by: currentUserId, created_by: currentUserId }, { onConflict: 'lead_id' });
  if (error) throw error;
}

export async function upsertParentDetails(leadId, fields, currentUserId) {
  const { error } = await supabase
    .from('lead_parent_details')
    .upsert({ lead_id: leadId, ...fields, updated_by: currentUserId, created_by: currentUserId }, { onConflict: 'lead_id' });
  if (error) throw error;
}

export async function updateCoApplicant(coApplicantId, fields) {
  const { error } = await supabase.from('co_applicants').update(fields).eq('id', coApplicantId);
  if (error) throw error;
}

export async function createCoApplicant(leadId, fields, currentUserId) {
  const { error } = await supabase.from('co_applicants').insert({ lead_id: leadId, ...fields, created_by: currentUserId, updated_by: currentUserId });
  if (error) throw error;
}

export async function upsertCollateralDetails(leadId, collateralId, fields, currentUserId) {
  if (collateralId) {
    const { error } = await supabase.from('lead_collateral_details').update(fields).eq('id', collateralId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('lead_collateral_details').insert({ lead_id: leadId, ...fields, created_by: currentUserId, updated_by: currentUserId });
  if (error) throw error;
}

// Fixed list for now — matches the roadmap's "adjust the list on request".
// Call outcome is two-level: an outcome (Connected / Not Connected) and a
// sub-disposition. We store the SUB-disposition as the lead_event's
// event_type — it's the granular signal, and 'Interested' specifically is
// what the stage automation watches to advance a lead to App Start.
export const CALL_DISPOSITIONS = {
  'Connected': ['Interested', 'In-follow up', 'Not Interested'],
  'Not Connected': ['Switched off', 'RNR', 'Call Back', 'Others'],
};
// Flat list of every sub-disposition — used to tell "this lead_event is a
// call" apart from stage changes etc. when counting call activity.
export const CALL_STATUS_OPTIONS = Object.values(CALL_DISPOSITIONS).flat();
// Which sub-dispositions count as a connected call (for connect-rate).
export const CONNECTED_DISPOSITIONS = CALL_DISPOSITIONS['Connected'];
// Which sub-dispositions force a follow-up date before the call can save.
export const FOLLOWUP_REQUIRED_DISPOSITIONS = ['Interested', 'In-follow up', 'Call Back', 'Switched off', 'RNR'];

/**
 * Logs a call as a lead_events row (shows up in the Timeline tab with no
 * extra UI needed) and, unless the outcome was "Not Interested", creates
 * the mandatory follow-up task and syncs leads.next_follow_up_at to its
 * due date so the Overview field and every "overdue follow-up" query
 * elsewhere in the app stay correct for free.
 */
export async function logCall(leadId, { callStatus, notes, taskTitle, taskDueDate }, currentUserId) {
  const { error: eventError } = await supabase.from('lead_events').insert({
    lead_id: leadId,
    event_type: callStatus,
    remarks: notes?.trim() || null,
    created_by: currentUserId,
  });
  if (eventError) throw eventError;

  if (!taskTitle) return;

  const { error: taskError } = await supabase.from('tasks').insert({
    title: taskTitle,
    due_date: taskDueDate,
    lead_id: leadId,
    assigned_to_user_id: currentUserId,
    created_by: currentUserId,
    updated_by: currentUserId,
  });
  if (taskError) throw new Error(`Call logged, but the follow-up task failed to save: ${taskError.message}`);

  const { error: leadUpdateError } = await supabase.from('leads').update({ next_follow_up_at: taskDueDate }).eq('id', leadId);
  if (leadUpdateError) throw new Error(`Call logged and task saved, but updating the lead's next follow-up failed: ${leadUpdateError.message}`);
}

export async function upsertReference(leadId, referenceType, fields, currentUserId) {
  const { error } = await supabase
    .from('lead_references')
    .upsert({ lead_id: leadId, reference_type: referenceType, ...fields, updated_by: currentUserId, created_by: currentUserId }, { onConflict: 'lead_id,reference_type' });
  if (error) throw error;
}

export async function getLeadTimeline(leadId) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('*, from_stage:lead_stages!lead_events_from_stage_id_fkey(name), to_stage:lead_stages!lead_events_to_stage_id_fkey(name), created_by_user:users(full_name)')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Creates a lead plus its opening "Lead Created" timeline event.
 * These two writes should be atomic; until that's moved into an RPC
 * (tracked in future improvements), we do the event insert immediately
 * after and surface a clear error if it fails so the caller can retry
 * the event write without duplicating the lead.
 */
export async function createLead(payload, currentUserId, initialStageId) {
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      ...payload,
      current_stage_id: initialStageId,
      created_by: currentUserId,
      updated_by: currentUserId,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: eventError } = await supabase.from('lead_events').insert({
    lead_id: lead.id,
    event_type: 'Lead Created',
    to_stage_id: initialStageId,
    created_by: currentUserId,
  });
  if (eventError) {
    // Lead exists but its opening event failed to write — surface distinctly
    // so the UI can tell the user to open the lead and check its timeline.
    throw new Error(`Lead saved, but its timeline entry failed: ${eventError.message}`);
  }

  return lead;
}

export async function changeLeadStage(leadId, newStageId, remarks) {
  const { error } = await supabase.rpc('change_lead_stage', {
    p_lead_id: leadId,
    p_new_stage_id: newStageId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}

export async function assignLeadToRm(leadId, newRmId, reason) {
  const { error } = await supabase.rpc('assign_lead', {
    p_lead_id: leadId,
    p_new_rm_id: newRmId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

/**
 * Assigns many leads in one call. The RPC loops assign_lead() internally, so
 * each lead still gets its lead_assignments row and 'Reassigned' timeline
 * event — identical audit trail to assigning them one by one, without 385
 * sequential round trips from the browser.
 * @returns {Promise<number>} how many were assigned
 */
export async function assignLeadsBulk(leadIds, newRmId, reason) {
  const { data, error } = await supabase.rpc('assign_leads_bulk', {
    p_lead_ids: leadIds,
    p_new_rm_id: newRmId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function getLostReasons() {
  const { data, error } = await supabase
    .from('lead_lost_reasons')
    .select('id, name')
    .eq('is_deleted', false)
    .eq('is_active', true)
    .order('sequence_order');
  if (error) throw error;
  return data;
}

export async function markLeadLost(leadId, reasonId, remarks) {
  const { error } = await supabase.rpc('mark_lead_lost', { p_lead_id: leadId, p_reason_id: reasonId, p_remarks: remarks ?? null });
  if (error) throw error;
}

export async function reopenLead(leadId) {
  const { error } = await supabase.rpc('reopen_lead', { p_lead_id: leadId });
  if (error) throw error;
}

/**
 * A lead's effective status once it's in the lender pipeline is the
 * furthest-along stage of any of its live deals — a deal at "Sanction"
 * means the lead is effectively Sanctioned, regardless of the lead's own
 * pipeline stage. Returns the highest deal-stage name among non-rejected
 * deals, or null when the lead has no live deals (caller falls back to
 * the lead's own stage). Rejected deals don't count as progress.
 *
 * For Consultant/BD, RLS returns zero deal rows, so this yields null and
 * they see the lead's own stage — exactly what we want.
 */
export async function getHighestDealStage(leadId) {
  const { data, error } = await supabase
    .from('deals')
    .select('current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name, sequence_order )')
    .eq('lead_id', leadId)
    .eq('is_deleted', false)
    .eq('is_rejected', false);
  if (error) throw error;
  const stages = (data || []).map((d) => d.current_deal_stage).filter(Boolean);
  if (stages.length === 0) return null;
  return stages.sort((a, b) => b.sequence_order - a.sequence_order)[0].name;
}

// ---------------------------------------------------------
// Lead editing (Admin / Manager)
// ---------------------------------------------------------

/**
 * Fields an Admin or Manager may edit from the "Edit lead" form.
 *
 * Deliberately a whitelist rather than "whatever the form submits". The
 * leads table also carries ownership, audit and automation columns
 * (assigned_rm_id, created_by, is_deleted, lost_reason_id, stage_manually_set
 * …) that have their own flows — reassignment, Mark as Lost, the stage
 * ratchet. Letting a generic edit form write those would quietly bypass the
 * event logging those flows do.
 *
 * current_stage_id is NOT here on purpose: stage is Admin-only and goes
 * through setLeadStage() so the change lands in the timeline.
 */
export const EDITABLE_LEAD_FIELDS = [
  'student_name', 'student_phone', 'student_email', 'student_dob',
  'alternate_phone', 'parent_alternate_number', 'gender', 'marital_status',
  'course_name', 'university_name', 'destination_country', 'degree',
  'intake_month', 'intake_year', 'admission_offer_status',
  'loan_amount_requested', 'currency', 'loan_type', 'total_study_cost',
  'self_funds_available', 'savings_amount', 'has_liabilities',
  'liabilities_amount', 'credit_score', 'employment_status',
  'lead_source_id', 'consultancy_id', 'consultancy_other_name', 'bd_name',
  'priority',
  'login_date', 'sanction_date', 'pf_date', 'disbursed_date',
  'disbursed_amount',
];

/**
 * Update a lead's own columns. Anything outside EDITABLE_LEAD_FIELDS is
 * dropped before the request rather than sent and rejected, so a stray form
 * field can't fail the whole save.
 *
 * RLS (migration 051) is the real gate — this narrowing is about not sending
 * nonsense, not about security.
 */
export async function updateLead(leadId, fields) {
  const payload = {};
  for (const key of EDITABLE_LEAD_FIELDS) {
    if (key in fields) payload[key] = fields[key];
  }
  if (Object.keys(payload).length === 0) return;
  const { error } = await supabase.from('leads').update(payload).eq('id', leadId);
  if (error) throw error;
}

/**
 * Admin-only manual stage override. The RPC re-checks the role, writes the
 * lead_events row, and sets stage_manually_set so the activity-driven
 * recompute stops moving this lead (see migration 055).
 */
export async function setLeadStage(leadId, stageId, remarks) {
  const { error } = await supabase.rpc('set_lead_stage', {
    p_lead_id: leadId,
    p_stage_id: stageId,
    p_remarks: remarks ?? null,
  });
  if (error) throw error;
}
