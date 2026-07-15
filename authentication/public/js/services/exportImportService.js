// =========================================================
// SERVICE LAYER — Admin Export/Import
// Uses PapaParse (CDN) for CSV parsing/generation. Only Admin should
// ever reach this page — RLS still applies underneath regardless
// (a non-Admin hitting these queries gets whatever their role's
// policies already allow, nothing more).
// =========================================================
import { supabase } from '../config/supabaseClient.js';

export async function exportLeadsCsv() {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      student_name, student_phone, student_email, course_name, university_name,
      destination_country, loan_amount_requested, currency, created_at,
      lead_stages ( name ), lead_sources ( name ),
      assigned_rm:users!leads_assigned_rm_id_fkey ( full_name )
    `)
    .eq('is_deleted', false);
  if (error) throw error;

  const rows = data.map((l) => ({
    student_name: l.student_name,
    student_phone: l.student_phone,
    student_email: l.student_email,
    course_name: l.course_name,
    university_name: l.university_name,
    destination_country: l.destination_country,
    loan_amount_requested: l.loan_amount_requested,
    currency: l.currency,
    stage: l.lead_stages?.name,
    source: l.lead_sources?.name,
    assigned_rm: l.assigned_rm?.full_name,
    created_at: l.created_at,
  }));
  return Papa.unparse(rows);
}

export async function exportDealsCsv() {
  const { data, error } = await supabase
    .from('deals')
    .select(`
      leads ( student_name ), lenders ( name ),
      current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name ),
      is_on_hold, is_rejected, total_disbursed_amount, final_disbursement_date, created_at
    `)
    .eq('is_deleted', false);
  if (error) throw error;

  const rows = data.map((d) => ({
    student_name: d.leads?.student_name,
    lender: d.lenders?.name,
    stage: d.current_deal_stage?.name,
    on_hold: d.is_on_hold,
    rejected: d.is_rejected,
    total_disbursed_amount: d.total_disbursed_amount,
    final_disbursement_date: d.final_disbursement_date,
    created_at: d.created_at,
  }));
  return Papa.unparse(rows);
}

export function downloadCsv(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const VALID_LOAN_TYPES = ['Collateral', 'Non Collateral'];

/**
 * Every column beyond the original 8 is optional and exists specifically
 * for HISTORICAL migration of leads from another system, so real history
 * is preserved instead of every migrated lead looking like it was just
 * created:
 *   - stage_name: current pipeline stage (must match an existing
 *     lead_stages.name exactly). Blank = the opening stage, same as before.
 *   - assigned_rm_email: the RM this lead is currently assigned to
 *     (resolved to users.id by email — must be an active user with the
 *     Relationship Manager role). Blank = unassigned.
 *   - created_date: backdates the lead's created_at AND the opening
 *     lead_events row's created_at to this date (YYYY-MM-DD), instead of
 *     defaulting to "now" like a freshly-created lead. Blank = now.
 *   - loan_type: "Collateral" or "Non Collateral". Blank = unset.
 *   - consultancy_name / consultancy_other_name: only meaningful (and
 *     required — one or the other) when source_name is "BD Partnership".
 *     consultancy_name must match an existing consultancies.name exactly;
 *     use consultancy_other_name for a consultancy not yet in the system.
 */
export function importTemplateCsv() {
  return Papa.unparse([
    {
      student_name: 'Jane Doe', student_phone: '+91 98765 43210', student_email: 'jane@example.com',
      course_name: 'MS Computer Science', university_name: 'Example University', destination_country: 'USA',
      loan_amount_requested: 2500000, source_name: 'Direct Website Inquiry',
      stage_name: 'Documents Received', assigned_rm_email: 'rm@example.com', created_date: '2025-03-14',
      loan_type: 'Non Collateral', consultancy_name: '', consultancy_other_name: '',
    },
  ]);
}

/**
 * Parses and validates a leads CSV, returning { validRows, errors }
 * without writing anything — the caller reviews this before committing.
 */
export async function parseLeadsCsv(file, currentUserId) {
  const [{ data: sources, error: sourcesError }, { data: stages, error: stagesError }, { data: rms, error: rmsError }, { data: consultancies, error: consultanciesError }] = await Promise.all([
    supabase.from('lead_sources').select('id, name').eq('is_deleted', false),
    supabase.from('lead_stages').select('id, name, sequence_order').eq('is_deleted', false),
    supabase.from('users').select('id, email, full_name, roles(name)').eq('is_deleted', false).eq('is_active', true),
    supabase.from('consultancies').select('id, name').eq('is_deleted', false),
  ]);
  if (sourcesError) throw sourcesError;
  if (stagesError) throw stagesError;
  if (rmsError) throw rmsError;
  if (consultanciesError) throw consultanciesError;
  const openingStage = stages.reduce((min, s) => (s.sequence_order < min.sequence_order ? s : min), stages[0]);

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const errors = [];
        const validRows = [];
        results.data.forEach((row, i) => {
          const rowNum = i + 2; // account for header row + 1-indexing
          if (!row.student_name?.trim()) { errors.push(`Row ${rowNum}: missing student_name`); return; }
          if (!row.student_phone?.trim()) { errors.push(`Row ${rowNum}: missing student_phone`); return; }
          const amount = Number(row.loan_amount_requested);
          if (!row.loan_amount_requested || Number.isNaN(amount) || amount <= 0) { errors.push(`Row ${rowNum}: invalid loan_amount_requested`); return; }
          const source = sources.find((s) => s.name.toLowerCase() === (row.source_name || '').trim().toLowerCase());
          if (!source) { errors.push(`Row ${rowNum}: unknown source_name "${row.source_name}"`); return; }

          let rowHasError = false;

          // stage_name — optional, defaults to the opening stage.
          let stageId = openingStage.id;
          const stageName = row.stage_name?.trim();
          if (stageName) {
            const stage = stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase());
            if (!stage) { errors.push(`Row ${rowNum}: unknown stage_name "${stageName}"`); rowHasError = true; }
            else stageId = stage.id;
          }

          // assigned_rm_email — optional, must be an active Relationship Manager.
          let assignedRmId = null;
          const rmEmail = row.assigned_rm_email?.trim();
          if (rmEmail) {
            const rm = rms.find((u) => u.email.toLowerCase() === rmEmail.toLowerCase());
            if (!rm) { errors.push(`Row ${rowNum}: no active user found with assigned_rm_email "${rmEmail}"`); rowHasError = true; }
            else if (rm.roles?.name !== 'Relationship Manager') { errors.push(`Row ${rowNum}: "${rmEmail}" is not a Relationship Manager (role: ${rm.roles?.name || 'unknown'})`); rowHasError = true; }
            else assignedRmId = rm.id;
          }

          // created_date — optional, backdates created_at / the opening event.
          let createdAt = null;
          const createdDateRaw = row.created_date?.trim();
          if (createdDateRaw) {
            const parsed = new Date(createdDateRaw);
            if (Number.isNaN(parsed.getTime())) { errors.push(`Row ${rowNum}: invalid created_date "${createdDateRaw}" (use YYYY-MM-DD)`); rowHasError = true; }
            else if (parsed.getTime() > Date.now()) { errors.push(`Row ${rowNum}: created_date "${createdDateRaw}" is in the future`); rowHasError = true; }
            else createdAt = parsed.toISOString();
          }

          // loan_type — optional.
          let loanType = null;
          const loanTypeRaw = row.loan_type?.trim();
          if (loanTypeRaw) {
            if (!VALID_LOAN_TYPES.includes(loanTypeRaw)) { errors.push(`Row ${rowNum}: loan_type must be "Collateral" or "Non Collateral", got "${loanTypeRaw}"`); rowHasError = true; }
            else loanType = loanTypeRaw;
          }

          // consultancy_name / consultancy_other_name — required (one or the
          // other) only when the source is BD Partnership.
          let consultancyId = null;
          const consultancyNameRaw = row.consultancy_name?.trim();
          const consultancyOtherNameRaw = row.consultancy_other_name?.trim() || null;
          if (consultancyNameRaw) {
            const consultancy = consultancies.find((c) => c.name.toLowerCase() === consultancyNameRaw.toLowerCase());
            if (!consultancy) { errors.push(`Row ${rowNum}: unknown consultancy_name "${consultancyNameRaw}"`); rowHasError = true; }
            else consultancyId = consultancy.id;
          }
          if (source.name === 'BD Partnership' && !consultancyId && !consultancyOtherNameRaw) {
            errors.push(`Row ${rowNum}: source_name is "BD Partnership" — consultancy_name or consultancy_other_name is required`);
            rowHasError = true;
          }

          if (rowHasError) return;

          const leadRow = {
            student_name: row.student_name.trim(),
            student_phone: row.student_phone.trim(),
            student_email: row.student_email?.trim() || null,
            course_name: row.course_name?.trim() || null,
            university_name: row.university_name?.trim() || null,
            destination_country: row.destination_country?.trim() || null,
            loan_amount_requested: amount,
            lead_source_id: source.id,
            current_stage_id: stageId,
            assigned_rm_id: assignedRmId,
            loan_type: loanType,
            consultancy_id: consultancyId,
            consultancy_other_name: consultancyOtherNameRaw,
            created_by: currentUserId,
            updated_by: currentUserId,
          };
          if (createdAt) leadRow.created_at = createdAt;

          validRows.push(leadRow);
        });
        resolve({ validRows, errors });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Inserts pre-validated rows and logs the opening timeline event for
 * each, one at a time so a single bad row doesn't abort the whole
 * batch — returns per-row success/failure so the UI can report exactly
 * what happened rather than an opaque "import failed". When the row
 * carries a backdated created_at (a historical migration), the opening
 * lead_events row is backdated to match, so the lead's timeline reads
 * correctly instead of showing "created today" for a lead that's been
 * live for months.
 */
export async function commitLeadImport(validRows) {
  let succeeded = 0;
  const failures = [];
  for (const row of validRows) {
    const { data: lead, error } = await supabase.from('leads').insert(row).select().single();
    if (error) {
      failures.push({ row, error: error.message });
      continue;
    }
    const eventRow = {
      lead_id: lead.id, event_type: 'Lead Created', to_stage_id: row.current_stage_id, created_by: row.created_by,
      remarks: row.created_at ? 'Migrated from historical data' : null,
    };
    if (row.created_at) eventRow.created_at = row.created_at;
    await supabase.from('lead_events').insert(eventRow);
    succeeded += 1;
  }
  return { succeeded, failures };
}

export function usersBulkUpdateTemplateCsv() {
  return Papa.unparse([
    { email: 'existing.user@example.com', role_name: '', reporting_manager_email: '', team_name: '', is_active: '' },
  ]);
}

/**
 * Every column except email is optional — a blank cell means "leave this
 * field unchanged". To explicitly clear reporting_manager_email or
 * team_name, put the literal word NONE in that cell.
 */
export async function parseUsersBulkUpdateCsv(file) {
  const [{ data: users, error: usersError }, { data: roles, error: rolesError }, { data: teams, error: teamsError }] = await Promise.all([
    supabase.from('users').select('id, email, roles(name)').eq('is_deleted', false),
    supabase.from('roles').select('id, name').eq('is_deleted', false),
    supabase.from('teams').select('id, name').eq('is_deleted', false),
  ]);
  if (usersError) throw usersError;
  if (rolesError) throw rolesError;
  if (teamsError) throw teamsError;

  const findUserByEmail = (email) => users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const errors = [];
        const validRows = [];
        results.data.forEach((row, i) => {
          const rowNum = i + 2;
          const email = row.email?.trim();
          if (!email) { errors.push(`Row ${rowNum}: missing email`); return; }
          const targetUser = findUserByEmail(email);
          if (!targetUser) { errors.push(`Row ${rowNum}: no user found with email "${email}"`); return; }

          const change = { userId: targetUser.id, email };
          let rowHasError = false;

          const roleName = row.role_name?.trim();
          if (roleName) {
            const role = roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
            if (!role) { errors.push(`Row ${rowNum}: unknown role_name "${roleName}"`); rowHasError = true; }
            else change.newRoleId = role.id;
          }

          const managerEmail = row.reporting_manager_email?.trim();
          if (managerEmail) {
            if (managerEmail.toUpperCase() === 'NONE') change.newManagerId = null;
            else {
              const manager = findUserByEmail(managerEmail);
              if (!manager) { errors.push(`Row ${rowNum}: no user found for reporting_manager_email "${managerEmail}"`); rowHasError = true; }
              else change.newManagerId = manager.id;
            }
          }

          const teamName = row.team_name?.trim();
          if (teamName) {
            if (teamName.toUpperCase() === 'NONE') change.teamId = null;
            else {
              const team = teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase());
              if (!team) { errors.push(`Row ${rowNum}: unknown team_name "${teamName}"`); rowHasError = true; }
              else change.teamId = team.id;
            }
          }

          const isActiveRaw = row.is_active?.trim();
          if (isActiveRaw) {
            if (isActiveRaw.toUpperCase() === 'TRUE') change.isActive = true;
            else if (isActiveRaw.toUpperCase() === 'FALSE') change.isActive = false;
            else { errors.push(`Row ${rowNum}: is_active must be TRUE or FALSE, got "${isActiveRaw}"`); rowHasError = true; }
          }

          if (!rowHasError) validRows.push(change);
        });
        resolve({ validRows, errors });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Applies each field of each row independently — a failed role change
 * on one row doesn't block that same row's manager/team update, and one
 * bad row never aborts the rest of the batch. Returns per-row failures
 * with which specific field failed so the UI can report exactly what
 * didn't take.
 */
export async function commitUsersBulkUpdate(validRows) {
  let succeeded = 0;
  const failures = [];
  for (const change of validRows) {
    const rowErrors = [];
    if (change.newRoleId) {
      const { error } = await supabase.rpc('change_user_role', { p_target_user_id: change.userId, p_new_role_id: change.newRoleId, p_remarks: 'Bulk update via Manage Users' });
      if (error) rowErrors.push(`role: ${error.message}`);
    }
    if ('newManagerId' in change) {
      const { error } = await supabase.rpc('change_reporting_manager', { p_target_user_id: change.userId, p_new_manager_id: change.newManagerId, p_remarks: 'Bulk update via Manage Users' });
      if (error) rowErrors.push(`reporting manager: ${error.message}`);
    }
    if ('teamId' in change) {
      const { error } = await supabase.from('users').update({ team_id: change.teamId }).eq('id', change.userId);
      if (error) rowErrors.push(`team: ${error.message}`);
    }
    if ('isActive' in change) {
      const { error } = await supabase.rpc(change.isActive ? 'reactivate_user' : 'deactivate_user', { p_target_user_id: change.userId, p_remarks: 'Bulk update via Manage Users' });
      if (error) rowErrors.push(`active status: ${error.message}`);
    }
    if (rowErrors.length > 0) failures.push({ email: change.email, error: rowErrors.join('; ') });
    else succeeded += 1;
  }
  return { succeeded, failures };
}
