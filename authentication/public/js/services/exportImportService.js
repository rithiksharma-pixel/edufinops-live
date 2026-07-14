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

export function importTemplateCsv() {
  return Papa.unparse([
    { student_name: 'Jane Doe', student_phone: '+91 98765 43210', student_email: 'jane@example.com', course_name: 'MS Computer Science', university_name: 'Example University', destination_country: 'USA', loan_amount_requested: 2500000, source_name: 'Direct Website Inquiry' },
  ]);
}

/**
 * Parses and validates a leads CSV, returning { validRows, errors }
 * without writing anything — the caller reviews this before committing.
 */
export async function parseLeadsCsv(file, currentUserId) {
  const { data: sources, error: sourcesError } = await supabase.from('lead_sources').select('id, name').eq('is_deleted', false);
  if (sourcesError) throw sourcesError;
  const { data: stages, error: stagesError } = await supabase.from('lead_stages').select('id, name, sequence_order').eq('is_deleted', false);
  if (stagesError) throw stagesError;
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

          validRows.push({
            student_name: row.student_name.trim(),
            student_phone: row.student_phone.trim(),
            student_email: row.student_email?.trim() || null,
            course_name: row.course_name?.trim() || null,
            university_name: row.university_name?.trim() || null,
            destination_country: row.destination_country?.trim() || null,
            loan_amount_requested: amount,
            lead_source_id: source.id,
            current_stage_id: openingStage.id,
            created_by: currentUserId,
            updated_by: currentUserId,
          });
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
 * what happened rather than an opaque "import failed".
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
    await supabase.from('lead_events').insert({
      lead_id: lead.id, event_type: 'Lead Created', to_stage_id: row.current_stage_id, created_by: row.created_by,
    });
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
