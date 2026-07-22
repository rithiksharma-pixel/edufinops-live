// =========================================================
// SERVICE LAYER — Admin Export/Import
// Uses PapaParse (CDN) for CSV parsing/generation. Only Admin should
// ever reach this page — RLS still applies underneath regardless
// (a non-Admin hitting these queries gets whatever their role's
// policies already allow, nothing more).
// =========================================================
import { supabase } from '../config/supabaseClient.js';

// PostgREST caps a single select at 1000 rows. For an export/backup that
// silently loses everything past the 1000th row, which is the last thing
// a "backup" should do — so page through in stable id order until a short
// page comes back. Ordering by the unique id (not created_at) keeps rows
// from shifting across page boundaries and being skipped or duplicated.
const EXPORT_PAGE = 1000;
async function fetchAllRows(table, selectStr) {
  const all = [];
  for (let from = 0; ; from += EXPORT_PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(selectStr)
      .eq('is_deleted', false)
      .order('id', { ascending: true })
      .range(from, from + EXPORT_PAGE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < EXPORT_PAGE) break;
  }
  return all;
}

export async function exportLeadsCsv() {
  const data = await fetchAllRows('leads', `
    student_name, student_phone, student_email, course_name, university_name,
    destination_country, loan_amount_requested, currency, created_at,
    lead_stages ( name ), lead_sources ( name ),
    assigned_rm:users!leads_assigned_rm_id_fkey ( full_name )
  `);

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
  const data = await fetchAllRows('deals', `
    leads ( student_name ), lenders ( name ),
    current_deal_stage:deal_stages!deals_current_deal_stage_id_fkey ( name ),
    is_on_hold, is_rejected, total_disbursed_amount, final_disbursement_date, created_at
  `);

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
 * Only student_phone is truly required — every other column is optional,
 * for HISTORICAL migration of leads from another system where not every
 * field is known:
 *   - student_name: blank on a new lead defaults to the phone number as
 *     a placeholder (the database itself requires some name).
 *   - source_name: current pipeline lead source (must match an existing
 *     lead_sources.name exactly). Blank on a new lead defaults to "Unknown".
 *   - loan_amount_requested: blank = unset.
 *   - stage_name: current pipeline stage (must match an existing
 *     lead_stages.name exactly). Blank = the opening stage, same as before.
 *   - assigned_rm_name: the RM this lead is currently assigned to
 *     (resolved to users.id by full name — must be an active user with the
 *     Relationship Manager role). Blank = unassigned.
 *   - created_date: backdates the lead's created_at AND the opening
 *     lead_events row's created_at to this date (YYYY-MM-DD), instead of
 *     defaulting to "now" like a freshly-created lead. Blank = now.
 *   - loan_type: "Collateral" or "Non Collateral". Blank = unset.
 *   - consultancy_name / consultancy_other_name: only meaningful (and
 *     required — one or the other) when source_name is "BD Partnership".
 *     consultancy_name is matched against existing consultancies leniently
 *     (case/whitespace/punctuation-insensitive, ignoring suffix words like
 *     "Consultancy"/"Pvt Ltd") — "ABC" will match "ABC Consultancy" if
 *     that's the only close candidate; the validation preview will note
 *     which rows were fuzzy-matched. Use consultancy_other_name for a
 *     consultancy not yet in the system at all.
 */
export function importTemplateCsv() {
  return Papa.unparse([
    {
      student_name: 'Jane Doe', student_phone: '+91 98765 43210', student_email: 'jane@example.com',
      course_name: 'MS Computer Science', university_name: 'Example University', destination_country: 'USA',
      loan_amount_requested: 2500000, source_name: 'Direct Website Inquiry',
      stage_name: 'Documents Received', assigned_rm_name: 'Priya Sharma', created_date: '2025-03-14',
      loan_type: 'Non Collateral', consultancy_name: '', consultancy_other_name: '',
    },
  ]);
}

const normalizePhone = (phone) => (phone || '').replace(/[^\d]/g, '');

// Strips whitespace/punctuation noise and common legal-entity suffix words
// so "ABC", "ABC Consultancy", and "ABC Consultants Pvt. Ltd." all reduce to
// the same core "abc" for matching purposes — real-world CSV exports rarely
// agree on the full legal name.
const CONSULTANCY_SUFFIX_WORDS = new Set(['consultancy', 'consultancies', 'consultant', 'consultants', 'consulting', 'services', 'service', 'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'co', 'company', 'group']);
const normalizeConsultancyCore = (name) => {
  const tokens = (name || '').toLowerCase().replace(/[.,&()]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && CONSULTANCY_SUFFIX_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
};

/**
 * Resolves a free-text consultancy name against the existing list:
 * exact (case-insensitive) match first, then a core-normalized match
 * (ignoring whitespace/punctuation and common suffix words like
 * "Consultancy"/"Pvt Ltd") if exactly one candidate qualifies. Returns
 * { consultancy, notice, error } — at most one of notice/error is set.
 * A fuzzy match is real but SILENT unless the caller surfaces `notice`,
 * so the person committing the import can see what was auto-linked.
 */
const resolveConsultancyName = (nameRaw, consultancies) => {
  const exact = consultancies.find((c) => c.name.toLowerCase() === nameRaw.toLowerCase());
  if (exact) return { consultancy: exact };

  const inputCore = normalizeConsultancyCore(nameRaw);
  const candidates = consultancies.filter((c) => normalizeConsultancyCore(c.name) === inputCore);
  if (candidates.length === 1) {
    return { consultancy: candidates[0], notice: `consultancy_name "${nameRaw}" matched existing consultancy "${candidates[0].name}"` };
  }
  if (candidates.length > 1) {
    return { error: `consultancy_name "${nameRaw}" matches more than one existing consultancy (${candidates.map((c) => c.name).join(', ')}) — use the exact name` };
  }

  const suggestion = consultancies.find((c) => {
    const core = normalizeConsultancyCore(c.name);
    return core.length > 0 && (core.includes(inputCore) || inputCore.includes(core));
  });
  return { error: `unknown consultancy_name "${nameRaw}"${suggestion ? ` — did you mean "${suggestion.name}"?` : ''}` };
};

/**
 * Parses and validates a leads CSV, returning { validRows, errors, notices }
 * without writing anything — the caller reviews this before committing.
 * `notices` are non-blocking (e.g. a fuzzy consultancy-name match) —
 * unlike `errors`, they don't stop that row from being imported.
 *
 * Upsert semantics: student_phone (digits-only, so formatting doesn't
 * matter) is the match key against existing leads. A match becomes an
 * UPDATE row — every other column is optional there, and a BLANK cell
 * leaves that field untouched on the existing lead (never nulls it out
 * from a sparse re-export). No match becomes an INSERT row — every column
 * there is optional too now, with sensible defaults for the two the
 * database itself requires (student_name, source_name — see above).
 */
export async function parseLeadsCsv(file, currentUserId) {
  // existingLeads and consultancies both need paging — the phone-dedup and
  // fuzzy-consultancy-match must see EVERY existing row, or a re-import
  // silently duplicates leads past the 1000th and fuzzy-matches against a
  // truncated list. Small lookups (sources/stages/rms) stay single-shot.
  const [{ data: sources, error: sourcesError }, { data: stages, error: stagesError }, { data: rms, error: rmsError }, consultancies, existingLeads] = await Promise.all([
    supabase.from('lead_sources').select('id, name').eq('is_deleted', false),
    supabase.from('lead_stages').select('id, name, sequence_order').eq('is_deleted', false),
    supabase.from('users').select('id, email, full_name, roles(name)').eq('is_deleted', false).eq('is_active', true),
    fetchAllRows('consultancies', 'id, name'),
    fetchAllRows('leads', 'id, student_phone'),
  ]);
  if (sourcesError) throw sourcesError;
  if (stagesError) throw stagesError;
  if (rmsError) throw rmsError;
  const openingStage = stages.reduce((min, s) => (s.sequence_order < min.sequence_order ? s : min), stages[0]);

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const errors = [];
        const notices = [];
        const validRows = [];
        results.data.forEach((row, i) => {
          const rowNum = i + 2; // account for header row + 1-indexing
          if (!row.student_phone?.trim()) { errors.push(`Row ${rowNum}: missing student_phone`); return; }

          const existingLead = existingLeads.find((l) => normalizePhone(l.student_phone) === normalizePhone(row.student_phone));
          const mode = existingLead ? 'update' : 'insert';

          let amount;
          const amountRaw = row.loan_amount_requested?.trim();
          if (amountRaw) {
            amount = Number(amountRaw);
            if (Number.isNaN(amount) || amount <= 0) { errors.push(`Row ${rowNum}: invalid loan_amount_requested`); return; }
          }

          const sourceNameRaw = row.source_name?.trim();
          let source = null;
          if (sourceNameRaw) {
            source = sources.find((s) => s.name.toLowerCase() === sourceNameRaw.toLowerCase());
            if (!source) { errors.push(`Row ${rowNum}: unknown source_name "${row.source_name}"`); return; }
          } else if (mode === 'insert') {
            source = sources.find((s) => s.name === 'Unknown');
          }

          let rowHasError = false;

          // stage_name — optional; defaults to the opening stage on insert,
          // left unchanged on update if blank.
          let stageId = mode === 'insert' ? openingStage.id : undefined;
          const stageName = row.stage_name?.trim();
          if (stageName) {
            const stage = stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase());
            if (!stage) { errors.push(`Row ${rowNum}: unknown stage_name "${stageName}"`); rowHasError = true; }
            else stageId = stage.id;
          }

          // assigned_rm_name — optional, must be an active Relationship Manager.
          let assignedRmId = mode === 'insert' ? null : undefined;
          const rmName = row.assigned_rm_name?.trim();
          if (rmName) {
            const matches = rms.filter((u) => u.full_name.toLowerCase() === rmName.toLowerCase());
            if (matches.length === 0) { errors.push(`Row ${rowNum}: no active user found with assigned_rm_name "${rmName}"`); rowHasError = true; }
            else if (matches.length > 1) { errors.push(`Row ${rowNum}: more than one active user is named "${rmName}" — use assigned_rm_email instead to disambiguate`); rowHasError = true; }
            else if (matches[0].roles?.name !== 'Relationship Manager') { errors.push(`Row ${rowNum}: "${rmName}" is not a Relationship Manager (role: ${matches[0].roles?.name || 'unknown'})`); rowHasError = true; }
            else assignedRmId = matches[0].id;
          } else {
            const rmEmail = row.assigned_rm_email?.trim();
            if (rmEmail) {
              const rm = rms.find((u) => u.email.toLowerCase() === rmEmail.toLowerCase());
              if (!rm) { errors.push(`Row ${rowNum}: no active user found with assigned_rm_email "${rmEmail}"`); rowHasError = true; }
              else if (rm.roles?.name !== 'Relationship Manager') { errors.push(`Row ${rowNum}: "${rmEmail}" is not a Relationship Manager (role: ${rm.roles?.name || 'unknown'})`); rowHasError = true; }
              else assignedRmId = rm.id;
            }
          }

          // created_date — optional, backdates created_at / the opening event
          // (insert only — an update never rewrites created_at).
          let createdAt = null;
          const createdDateRaw = row.created_date?.trim();
          if (createdDateRaw) {
            const parsed = new Date(createdDateRaw);
            if (Number.isNaN(parsed.getTime())) { errors.push(`Row ${rowNum}: invalid created_date "${createdDateRaw}" (use YYYY-MM-DD)`); rowHasError = true; }
            else if (parsed.getTime() > Date.now()) { errors.push(`Row ${rowNum}: created_date "${createdDateRaw}" is in the future`); rowHasError = true; }
            else createdAt = parsed.toISOString();
          }

          // loan_type — optional.
          let loanType = mode === 'insert' ? null : undefined;
          const loanTypeRaw = row.loan_type?.trim();
          if (loanTypeRaw) {
            if (!VALID_LOAN_TYPES.includes(loanTypeRaw)) { errors.push(`Row ${rowNum}: loan_type must be "Collateral" or "Non Collateral", got "${loanTypeRaw}"`); rowHasError = true; }
            else loanType = loanTypeRaw;
          }

          // consultancy_name / consultancy_other_name — required (one or the
          // other) only when we know the source is BD Partnership (insert
          // always knows it; update only if source_name was given here).
          let consultancyId = mode === 'insert' ? null : undefined;
          const consultancyNameRaw = row.consultancy_name?.trim();
          const consultancyOtherNameRaw = row.consultancy_other_name?.trim() || undefined;
          if (consultancyNameRaw) {
            const { consultancy, notice, error } = resolveConsultancyName(consultancyNameRaw, consultancies);
            if (error) { errors.push(`Row ${rowNum}: ${error}`); rowHasError = true; }
            else {
              consultancyId = consultancy.id;
              if (notice) notices.push(`Row ${rowNum}: ${notice}`);
            }
          }
          if (source?.name === 'BD Partnership' && !consultancyId && !consultancyOtherNameRaw) {
            errors.push(`Row ${rowNum}: source_name is "BD Partnership" — consultancy_name or consultancy_other_name is required`);
            rowHasError = true;
          }
          if (mode === 'insert' && !source) {
            errors.push(`Row ${rowNum}: source_name is blank and the fallback "Unknown" lead source doesn't exist yet — run migration 017 first`);
            rowHasError = true;
          }

          if (rowHasError) return;

          if (mode === 'update') {
            const patch = { updated_by: currentUserId };
            if (row.student_name?.trim()) patch.student_name = row.student_name.trim();
            if (row.student_email?.trim()) patch.student_email = row.student_email.trim();
            if (row.course_name?.trim()) patch.course_name = row.course_name.trim();
            if (row.university_name?.trim()) patch.university_name = row.university_name.trim();
            if (row.destination_country?.trim()) patch.destination_country = row.destination_country.trim();
            if (amount !== undefined) patch.loan_amount_requested = amount;
            if (source) patch.lead_source_id = source.id;
            if (stageId !== undefined) patch.current_stage_id = stageId;
            if (assignedRmId !== undefined) patch.assigned_rm_id = assignedRmId;
            if (loanType !== undefined) patch.loan_type = loanType;
            if (consultancyId !== undefined) patch.consultancy_id = consultancyId;
            if (consultancyOtherNameRaw !== undefined) patch.consultancy_other_name = consultancyOtherNameRaw;
            validRows.push({ mode, id: existingLead.id, patch, stageChanged: stageId !== undefined });
          } else {
            const leadRow = {
              student_name: row.student_name?.trim() || row.student_phone.trim(),
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
              consultancy_other_name: consultancyOtherNameRaw ?? null,
              created_by: currentUserId,
              updated_by: currentUserId,
            };
            if (createdAt) leadRow.created_at = createdAt;
            validRows.push({ mode, row: leadRow });
          }
        });
        resolve({ validRows, errors, notices });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Inserts or updates pre-validated rows one at a time so a single bad
 * row doesn't abort the whole batch — returns per-row success/failure
 * so the UI can report exactly what happened. Every insert logs the
 * opening "Lead Created" timeline event (backdated to match a
 * historical migration's created_date, if given); every update logs a
 * "Lead Updated (bulk import)" event, for the same audit-trail parity
 * every other mutation in this schema already has.
 */
export async function commitLeadImport(validRows) {
  let succeeded = 0;
  const failures = [];
  for (const entry of validRows) {
    if (entry.mode === 'update') {
      const { error } = await supabase.from('leads').update(entry.patch).eq('id', entry.id);
      if (error) { failures.push({ row: entry, error: error.message }); continue; }
      await supabase.from('lead_events').insert({
        lead_id: entry.id, event_type: 'Lead Updated (bulk import)', to_stage_id: entry.stageChanged ? entry.patch.current_stage_id : null, created_by: entry.patch.updated_by,
      });
      succeeded += 1;
      continue;
    }

    const row = entry.row;
    const { data: lead, error } = await supabase.from('leads').insert(row).select().single();
    if (error) {
      failures.push({ row: entry, error: error.message });
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

export function consultanciesBulkImportTemplateCsv() {
  return Papa.unparse([
    { name: 'GlobalEd Consultants', is_active: 'TRUE' },
  ]);
}

/**
 * Matches existing consultancies case-insensitively by name (upsert):
 * a match updates is_active on the existing row, anything else inserts
 * a new one. is_active is optional on insert too — blank defaults to
 * active, matching the single-create form in Admin Settings.
 */
export async function parseConsultanciesCsv(file, currentUserId) {
  // Paged: the consultancy list is already ~750 and climbing; a truncated
  // dedup would start re-inserting existing names.
  const existing = await fetchAllRows('consultancies', 'id, name');

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const errors = [];
        const validRows = [];
        const seenNames = new Map(); // lowercase name -> row number, for intra-file duplicate detection
        results.data.forEach((row, i) => {
          const rowNum = i + 2;
          const name = row.name?.trim();
          if (!name) { errors.push(`Row ${rowNum}: missing name`); return; }

          const nameKey = name.toLowerCase();
          if (seenNames.has(nameKey)) {
            errors.push(`Row ${rowNum}: duplicate name "${name}" (already on row ${seenNames.get(nameKey)})`);
            return;
          }
          seenNames.set(nameKey, rowNum);

          let isActive;
          const isActiveRaw = row.is_active?.trim();
          if (isActiveRaw) {
            if (isActiveRaw.toUpperCase() === 'TRUE') isActive = true;
            else if (isActiveRaw.toUpperCase() === 'FALSE') isActive = false;
            else { errors.push(`Row ${rowNum}: is_active must be TRUE or FALSE, got "${isActiveRaw}"`); return; }
          }

          const match = existing.find((c) => c.name.toLowerCase() === nameKey);
          if (match) {
            validRows.push({ mode: 'update', id: match.id, name, isActive, updatedBy: currentUserId });
          } else {
            validRows.push({ mode: 'insert', name, isActive, createdBy: currentUserId, updatedBy: currentUserId });
          }
        });
        resolve({ validRows, errors });
      },
      error: (err) => reject(err),
    });
  });
}

export async function commitConsultancyImport(validRows) {
  let succeeded = 0;
  const failures = [];
  for (const row of validRows) {
    let error;
    if (row.mode === 'update') {
      const patch = { updated_by: row.updatedBy };
      if (row.isActive !== undefined) patch.is_active = row.isActive;
      ({ error } = await supabase.from('consultancies').update(patch).eq('id', row.id));
    } else {
      const insertRow = { name: row.name, created_by: row.createdBy, updated_by: row.updatedBy };
      if (row.isActive !== undefined) insertRow.is_active = row.isActive;
      ({ error } = await supabase.from('consultancies').insert(insertRow));
    }
    if (error) failures.push({ name: row.name, error: error.message });
    else succeeded += 1;
  }
  return { succeeded, failures };
}

export function lendersBulkImportTemplateCsv() {
  return Papa.unparse([
    { lender_name: 'Example Bank', lender_code: 'EXBANK', branch_name: 'Bangalore', contact_email: '', contact_phone: '' },
    { lender_name: 'Example Bank', lender_code: 'EXBANK', branch_name: 'Mumbai', contact_email: '', contact_phone: '' },
    { lender_name: 'Other Financial Co', lender_code: 'OFC', branch_name: '', contact_email: 'ops@example.com', contact_phone: '' },
  ]);
}

/**
 * One row per branch; a blank branch_name means "lender only, no branch
 * on this row" (still creates/updates the lender). Rows sharing the
 * same lender_code add multiple branches under one lender.
 *
 * Natural keys: lenders match on code (stricter-unique than name);
 * branches match on (lender_id, name). If a lender_code already exists
 * with a DIFFERENT name than the CSV — or two rows in the same file
 * disagree on the name for one code — that's rejected as a conflict
 * rather than silently renaming anything.
 */
export async function parseLendersCsv(file, currentUserId) {
  const [{ data: existingLenders, error: lendersError }, { data: existingBranches, error: branchesError }] = await Promise.all([
    supabase.from('lenders').select('id, name, code').eq('is_deleted', false),
    supabase.from('lender_branches').select('id, lender_id, name').eq('is_deleted', false),
  ]);
  if (lendersError) throw lendersError;
  if (branchesError) throw branchesError;

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const errors = [];
        const validRows = [];
        const groupsByCode = new Map(); // lender_code (upper) -> { name, rows: [{rowNum, branchName, contactEmail, contactPhone}] }

        results.data.forEach((row, i) => {
          const rowNum = i + 2;
          const lenderName = row.lender_name?.trim();
          const lenderCode = row.lender_code?.trim();
          if (!lenderName) { errors.push(`Row ${rowNum}: missing lender_name`); return; }
          if (!lenderCode) { errors.push(`Row ${rowNum}: missing lender_code`); return; }

          const codeKey = lenderCode.toUpperCase();
          const existingLender = existingLenders.find((l) => l.code.toUpperCase() === codeKey);
          if (existingLender && existingLender.name.toLowerCase() !== lenderName.toLowerCase()) {
            errors.push(`Row ${rowNum}: lender_code "${lenderCode}" already exists with name "${existingLender.name}", this row has "${lenderName}" — resolve the name conflict before importing`);
            return;
          }

          let group = groupsByCode.get(codeKey);
          if (!group) {
            group = { name: lenderName, rows: [] };
            groupsByCode.set(codeKey, group);
          } else if (group.name.toLowerCase() !== lenderName.toLowerCase()) {
            errors.push(`Row ${rowNum}: lender_code "${lenderCode}" was given as "${group.name}" earlier in this file and "${lenderName}" here — pick one name per code`);
            return;
          }

          group.rows.push({
            rowNum,
            branchName: row.branch_name?.trim() || null,
            contactEmail: row.contact_email?.trim() || null,
            contactPhone: row.contact_phone?.trim() || null,
          });
        });

        for (const [codeKey, group] of groupsByCode) {
          const existingLender = existingLenders.find((l) => l.code.toUpperCase() === codeKey);
          const lenderRow = existingLender
            ? { type: 'lender', mode: 'update', id: existingLender.id, code: codeKey, name: group.name, updatedBy: currentUserId }
            : { type: 'lender', mode: 'insert', code: codeKey, name: group.name, createdBy: currentUserId, updatedBy: currentUserId };

          // First non-empty contact_email/contact_phone in the group wins,
          // applied to the lender row itself (they're lender-level fields,
          // not branch-level, even though the CSV repeats them per row).
          const contactRow = group.rows.find((r) => r.contactEmail || r.contactPhone);
          if (contactRow) {
            if (contactRow.contactEmail) lenderRow.contactEmail = contactRow.contactEmail;
            if (contactRow.contactPhone) lenderRow.contactPhone = contactRow.contactPhone;
          }
          validRows.push(lenderRow);

          const seenBranchNames = new Map();
          for (const r of group.rows) {
            if (!r.branchName) continue; // lender-only row
            const branchKey = r.branchName.toLowerCase();
            if (seenBranchNames.has(branchKey)) {
              errors.push(`Row ${r.rowNum}: duplicate branch_name "${r.branchName}" for lender_code "${codeKey}" (already on row ${seenBranchNames.get(branchKey)})`);
              continue;
            }
            seenBranchNames.set(branchKey, r.rowNum);

            const existingBranch = existingLender
              ? existingBranches.find((b) => b.lender_id === existingLender.id && b.name.toLowerCase() === branchKey)
              : null;
            validRows.push(existingBranch
              ? { type: 'branch', mode: 'update', id: existingBranch.id, lenderCode: codeKey, name: r.branchName, updatedBy: currentUserId }
              : { type: 'branch', mode: 'insert', lenderCode: codeKey, name: r.branchName, createdBy: currentUserId, updatedBy: currentUserId });
          }
        }

        resolve({ validRows, errors });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Lenders are committed before their branches (a brand-new lender's id
 * isn't known until its insert returns), grouped by lender_code so a
 * failed lender's branches are reported as blocked rather than
 * attempted against a nonexistent lender_id.
 */
export async function commitLenderImport(validRows) {
  let succeeded = 0;
  const failures = [];
  const lenderIdByCode = new Map();

  for (const row of validRows.filter((r) => r.type === 'lender')) {
    let error;
    if (row.mode === 'update') {
      const patch = { name: row.name, updated_by: row.updatedBy };
      if (row.contactEmail) patch.contact_email = row.contactEmail;
      if (row.contactPhone) patch.contact_phone = row.contactPhone;
      ({ error } = await supabase.from('lenders').update(patch).eq('id', row.id));
      if (!error) lenderIdByCode.set(row.code, row.id);
    } else {
      const insertRow = { name: row.name, code: row.code, created_by: row.createdBy, updated_by: row.updatedBy };
      if (row.contactEmail) insertRow.contact_email = row.contactEmail;
      if (row.contactPhone) insertRow.contact_phone = row.contactPhone;
      const { data, error: insertError } = await supabase.from('lenders').insert(insertRow).select().single();
      error = insertError;
      if (!error) lenderIdByCode.set(row.code, data.id);
    }
    if (error) failures.push({ label: `Lender "${row.name}" (${row.code})`, error: error.message });
    else succeeded += 1;
  }

  for (const row of validRows.filter((r) => r.type === 'branch')) {
    const lenderId = lenderIdByCode.get(row.lenderCode);
    if (!lenderId) {
      failures.push({ label: `Branch "${row.name}" for lender code "${row.lenderCode}"`, error: 'skipped — the lender for this code failed to import' });
      continue;
    }
    const { error } = row.mode === 'update'
      ? await supabase.from('lender_branches').update({ name: row.name, updated_by: row.updatedBy }).eq('id', row.id)
      : await supabase.from('lender_branches').insert({ lender_id: lenderId, name: row.name, created_by: row.createdBy, updated_by: row.updatedBy });
    if (error) failures.push({ label: `Branch "${row.name}" (${row.lenderCode})`, error: error.message });
    else succeeded += 1;
  }

  return { succeeded, failures };
}

export function dealHistoryBulkImportTemplateCsv() {
  return Papa.unparse([
    {
      student_phone: '+91 98765 43210', lender_name: 'Example Bank', branch_name: 'Bangalore',
      current_stage_name: 'PF', current_disposition_name: '',
      region_shared_date: '2025-01-10', sm_shared_date: '2025-01-11', rm_shared_date: '2025-01-12', eligibility_status: 'Eligible',
      loan_required_amount: 2500000, login_amount: 2500000, login_date: '2025-01-20', probable_sanction_date: '2025-02-05',
      sanction_amount: 2400000, sanction_date: '2025-02-03', probable_pf_date: '2025-02-20', interest_rate: 10.5, tenure_months: 84, moratorium_months: 12,
      pf_amount: 2400000, pf_date: '2025-02-18', probable_disbursement_date: '2025-03-01',
      disbursement_tranche_number: '', disbursement_amount: '', disbursement_date: '', academic_term: '',
      is_on_hold: 'FALSE', hold_reason_name: '',
      is_rejected: 'FALSE', rejection_reason_name: '',
    },
  ]);
}

const parseDateOnly = (raw, rowNum, fieldName, errors) => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) { errors.push(`Row ${rowNum}: invalid ${fieldName} "${trimmed}" (use YYYY-MM-DD)`); return null; }
  return trimmed;
};

const parseNumber = (raw, rowNum, fieldName, errors) => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const num = Number(trimmed);
  if (Number.isNaN(num)) { errors.push(`Row ${rowNum}: invalid ${fieldName} "${trimmed}"`); return null; }
  return num;
};

/**
 * One row per lead-per-lender deal. Unlike parseLeadsCsv, this never
 * creates leads — student_phone must already match an existing lead
 * (import leads first). Upsert semantics: an existing deal for that
 * (lead, lender) pair is updated in place; otherwise a new deal is
 * created via the same share_lead_with_lender path the Lenders tab's
 * Share button uses, then advanced to current_stage_name.
 *
 * Stage-detail fields (region_shared_date..probable_disbursement_date)
 * are all optional and independent of current_stage_name — e.g. a deal
 * currently at PF can still carry its earlier login_date/sanction_date
 * for a complete history. Blank cells are left unset, never overwritten
 * with null on an update.
 *
 * Only ONE disbursement tranche can be recorded per row (tranche_number
 * default 1). A deal with multiple historical tranches needs a second
 * pass — not supported in a single import row.
 *
 * Known limitation: no synthetic deal_events timeline rows are
 * backdated for the stages a deal passed through before its current
 * one — only the current stage/status and detail-table dates are
 * recorded, not a full historical audit trail.
 */
export async function parseDealHistoryCsv(file, currentUserId) {
  const [
    { data: leads, error: leadsError },
    { data: lenders, error: lendersError },
    { data: branches, error: branchesError },
    { data: stages, error: stagesError },
    { data: statuses, error: statusesError },
    { data: holdReasons, error: holdReasonsError },
    { data: rejectionReasons, error: rejectionReasonsError },
    { data: existingDeals, error: existingDealsError },
    { data: lenderStatusRows, error: lenderStatusError },
  ] = await Promise.all([
    supabase.from('leads').select('id, student_phone').eq('is_deleted', false),
    supabase.from('lenders').select('id, name').eq('is_deleted', false),
    supabase.from('lender_branches').select('id, lender_id, name').eq('is_deleted', false),
    supabase.from('deal_stages').select('id, name, sequence_order').eq('is_deleted', false),
    supabase.from('deal_stage_statuses').select('id, deal_stage_id, name').eq('is_deleted', false),
    supabase.from('deal_hold_reasons').select('id, name').eq('is_deleted', false),
    supabase.from('deal_rejection_reasons').select('id, name').eq('is_deleted', false),
    supabase.from('deals').select('id, lead_id, lender_id, current_deal_stage_id').eq('is_deleted', false),
    supabase.from('lead_lender_status').select('id, lead_id, lender_id'),
  ]);
  if (leadsError) throw leadsError;
  if (lendersError) throw lendersError;
  if (branchesError) throw branchesError;
  if (stagesError) throw stagesError;
  if (statusesError) throw statusesError;
  if (holdReasonsError) throw holdReasonsError;
  if (rejectionReasonsError) throw rejectionReasonsError;
  if (existingDealsError) throw existingDealsError;
  if (lenderStatusError) throw lenderStatusError;

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const errors = [];
        const validRows = [];
        const seenPairs = new Map(); // "leadId|lenderId" -> row number, for intra-file duplicate detection

        results.data.forEach((row, i) => {
          const rowNum = i + 2;
          let rowHasError = false;
          const fail = (msg) => { errors.push(`Row ${rowNum}: ${msg}`); rowHasError = true; };

          const phone = row.student_phone?.trim();
          if (!phone) { fail('missing student_phone'); return; }
          const lead = leads.find((l) => normalizePhone(l.student_phone) === normalizePhone(phone));
          if (!lead) { fail(`no lead found with student_phone "${phone}" — import leads first`); return; }

          const lenderNameRaw = row.lender_name?.trim();
          if (!lenderNameRaw) { fail('missing lender_name'); return; }
          const lender = lenders.find((l) => l.name.toLowerCase() === lenderNameRaw.toLowerCase());
          if (!lender) { fail(`unknown lender_name "${lenderNameRaw}"`); return; }

          const pairKey = `${lead.id}|${lender.id}`;
          if (seenPairs.has(pairKey)) { fail(`duplicate row for this student + lender (already on row ${seenPairs.get(pairKey)})`); return; }
          seenPairs.set(pairKey, rowNum);

          let branchId;
          const branchNameRaw = row.branch_name?.trim();
          if (branchNameRaw) {
            const branch = branches.find((b) => b.lender_id === lender.id && b.name.toLowerCase() === branchNameRaw.toLowerCase());
            if (!branch) fail(`unknown branch_name "${branchNameRaw}" for lender "${lenderNameRaw}"`);
            else branchId = branch.id;
          }

          const stageNameRaw = row.current_stage_name?.trim();
          if (!stageNameRaw) { fail('missing current_stage_name'); return; }
          const stage = stages.find((s) => s.name.toLowerCase() === stageNameRaw.toLowerCase());
          if (!stage) { fail(`unknown current_stage_name "${stageNameRaw}"`); return; }

          let statusId = null;
          const statusNameRaw = row.current_disposition_name?.trim();
          if (statusNameRaw) {
            const status = statuses.find((s) => s.deal_stage_id === stage.id && s.name.toLowerCase() === statusNameRaw.toLowerCase());
            if (!status) fail(`unknown current_disposition_name "${statusNameRaw}" for stage "${stageNameRaw}"`);
            else statusId = status.id;
          }

          const bankProspectFields = {};
          ['region_shared_date', 'sm_shared_date', 'rm_shared_date'].forEach((f) => {
            const v = parseDateOnly(row[f], rowNum, f, errors);
            if (v === null) rowHasError = true; else if (v !== undefined) bankProspectFields[f] = v;
          });
          if (row.eligibility_status?.trim()) bankProspectFields.eligibility_status = row.eligibility_status.trim();

          const loginFields = {};
          ['loan_required_amount', 'login_amount'].forEach((f) => {
            const v = parseNumber(row[f], rowNum, f, errors);
            if (v === null) rowHasError = true; else if (v !== undefined) loginFields[f] = v;
          });
          ['login_date', 'probable_sanction_date'].forEach((f) => {
            const v = parseDateOnly(row[f], rowNum, f, errors);
            if (v === null) rowHasError = true; else if (v !== undefined) loginFields[f] = v;
          });

          const sanctionFields = {};
          ['sanction_amount', 'interest_rate', 'tenure_months', 'moratorium_months'].forEach((f) => {
            const v = parseNumber(row[f], rowNum, f, errors);
            if (v === null) rowHasError = true; else if (v !== undefined) sanctionFields[f] = v;
          });
          ['sanction_date', 'probable_pf_date'].forEach((f) => {
            const v = parseDateOnly(row[f], rowNum, f, errors);
            if (v === null) rowHasError = true; else if (v !== undefined) sanctionFields[f] = v;
          });

          const pfFields = {};
          const pfAmount = parseNumber(row.pf_amount, rowNum, 'pf_amount', errors);
          if (pfAmount === null) rowHasError = true; else if (pfAmount !== undefined) pfFields.pf_amount = pfAmount;
          ['pf_date', 'probable_disbursement_date'].forEach((f) => {
            const v = parseDateOnly(row[f], rowNum, f, errors);
            if (v === null) rowHasError = true; else if (v !== undefined) pfFields[f] = v;
          });

          let disbursement;
          const disbAmount = parseNumber(row.disbursement_amount, rowNum, 'disbursement_amount', errors);
          if (disbAmount === null) rowHasError = true;
          const disbDate = parseDateOnly(row.disbursement_date, rowNum, 'disbursement_date', errors);
          if (disbDate === null) rowHasError = true;
          if (disbAmount !== undefined || disbDate !== undefined) {
            if (disbAmount === undefined || disbDate === undefined) {
              fail('disbursement_amount and disbursement_date must both be given together');
            } else {
              let trancheNumber = 1;
              const trancheRaw = row.disbursement_tranche_number?.trim();
              if (trancheRaw) {
                trancheNumber = Number(trancheRaw);
                if (!Number.isInteger(trancheNumber) || trancheNumber < 1) fail(`invalid disbursement_tranche_number "${trancheRaw}"`);
              }
              disbursement = { trancheNumber, amount: disbAmount, date: disbDate, academicTerm: row.academic_term?.trim() || null };
            }
          }

          let isOnHold = false;
          let holdReasonId;
          const isOnHoldRaw = row.is_on_hold?.trim();
          if (isOnHoldRaw) {
            if (isOnHoldRaw.toUpperCase() === 'TRUE') isOnHold = true;
            else if (isOnHoldRaw.toUpperCase() !== 'FALSE') fail(`is_on_hold must be TRUE or FALSE, got "${isOnHoldRaw}"`);
          }
          if (isOnHold) {
            const holdReasonNameRaw = row.hold_reason_name?.trim();
            if (!holdReasonNameRaw) fail('is_on_hold is TRUE but hold_reason_name is missing');
            else {
              const holdReason = holdReasons.find((r) => r.name.toLowerCase() === holdReasonNameRaw.toLowerCase());
              if (!holdReason) fail(`unknown hold_reason_name "${holdReasonNameRaw}"`);
              else holdReasonId = holdReason.id;
            }
          }

          let isRejected = false;
          let rejectionReasonId;
          const isRejectedRaw = row.is_rejected?.trim();
          if (isRejectedRaw) {
            if (isRejectedRaw.toUpperCase() === 'TRUE') isRejected = true;
            else if (isRejectedRaw.toUpperCase() !== 'FALSE') fail(`is_rejected must be TRUE or FALSE, got "${isRejectedRaw}"`);
          }
          if (isRejected) {
            const rejectionReasonNameRaw = row.rejection_reason_name?.trim();
            if (!rejectionReasonNameRaw) fail('is_rejected is TRUE but rejection_reason_name is missing');
            else {
              const rejectionReason = rejectionReasons.find((r) => r.name.toLowerCase() === rejectionReasonNameRaw.toLowerCase());
              if (!rejectionReason) fail(`unknown rejection_reason_name "${rejectionReasonNameRaw}"`);
              else rejectionReasonId = rejectionReason.id;
            }
          }

          if (rowHasError) return;

          const existingDeal = existingDeals.find((d) => d.lead_id === lead.id && d.lender_id === lender.id);
          const mode = existingDeal ? 'update' : 'insert';

          let lenderStatusId;
          if (mode === 'insert') {
            const statusRow = lenderStatusRows.find((r) => r.lead_id === lead.id && r.lender_id === lender.id);
            if (!statusRow) { fail(`no lead_lender_status row found for this student + lender — this shouldn't happen for an existing lender, please report it`); return; }
            lenderStatusId = statusRow.id;
          }

          validRows.push({
            rowNum, mode, studentPhone: phone, lenderName: lenderNameRaw,
            dealId: existingDeal?.id, lenderStatusId, branchId,
            stageId: stage.id, statusId,
            bankProspectFields, loginFields, sanctionFields, pfFields,
            disbursement, isOnHold, holdReasonId, isRejected, rejectionReasonId,
            currentUserId,
          });
        });
        resolve({ validRows, errors });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Commits pre-validated deal-history rows one at a time, reusing the
 * same RPCs the live UI uses (share_lead_with_lender, change_deal_stage,
 * record_disbursement, put_deal_on_hold, reject_deal) so this import
 * can never leave a deal in a state the normal app couldn't also reach
 * — total_disbursed_amount stays in sync and every RPC's own deal_events
 * row is written automatically. Stage-detail tables are upserted
 * directly (on deal_id) since a deal jumping straight to e.g. PF only
 * has change_deal_stage seed its PF row, not the earlier Login/Sanction
 * ones this row might also be carrying dates for.
 */
export async function commitDealHistoryImport(validRows) {
  let succeeded = 0;
  const failures = [];

  for (const row of validRows) {
    const label = `${row.studentPhone} — ${row.lenderName}`;
    let dealId = row.dealId;

    if (row.mode === 'insert') {
      const { data, error } = await supabase.rpc('share_lead_with_lender', {
        p_lead_lender_status_id: row.lenderStatusId,
        p_loan_officer_id: null,
        p_remarks: 'Migrated from historical data',
      });
      if (error) { failures.push({ label, error: error.message }); continue; }
      dealId = data;
    }

    if (row.branchId) {
      const { error } = await supabase.from('deals').update({ lender_branch_id: row.branchId }).eq('id', dealId);
      if (error) { failures.push({ label, error: `region: ${error.message}` }); continue; }
    }

    const { error: stageError } = await supabase.rpc('change_deal_stage', {
      p_deal_id: dealId,
      p_new_stage_id: row.stageId,
      p_new_status_id: row.statusId,
      p_remarks: 'Migrated from historical data',
      // Historical rows carry a final stage that can legitimately jump past
      // intermediate ones — allow the skip rather than depending on the
      // importer being run by an Admin.
      p_allow_skip: true,
    });
    if (stageError) { failures.push({ label, error: `stage: ${stageError.message}` }); continue; }

    let detailError;
    if (Object.keys(row.bankProspectFields).length > 0) {
      ({ error: detailError } = await supabase.from('deal_bank_prospect_details').upsert({ deal_id: dealId, ...row.bankProspectFields }, { onConflict: 'deal_id' }));
    }
    if (!detailError && Object.keys(row.loginFields).length > 0) {
      ({ error: detailError } = await supabase.from('deal_login_details').upsert({ deal_id: dealId, ...row.loginFields }, { onConflict: 'deal_id' }));
    }
    if (!detailError && Object.keys(row.sanctionFields).length > 0) {
      ({ error: detailError } = await supabase.from('deal_sanction_details').upsert({ deal_id: dealId, ...row.sanctionFields }, { onConflict: 'deal_id' }));
    }
    if (!detailError && Object.keys(row.pfFields).length > 0) {
      ({ error: detailError } = await supabase.from('deal_pf_details').upsert({ deal_id: dealId, ...row.pfFields }, { onConflict: 'deal_id' }));
    }
    if (detailError) { failures.push({ label, error: `stage details: ${detailError.message}` }); continue; }

    if (row.disbursement) {
      const { error } = await supabase.rpc('record_disbursement', {
        p_deal_id: dealId,
        p_tranche_number: row.disbursement.trancheNumber,
        p_amount: row.disbursement.amount,
        p_disbursed_date: row.disbursement.date,
        p_academic_term: row.disbursement.academicTerm,
        p_remarks: 'Migrated from historical data',
      });
      if (error) { failures.push({ label, error: `disbursement: ${error.message}` }); continue; }
    }

    if (row.isOnHold) {
      const { error } = await supabase.rpc('put_deal_on_hold', { p_deal_id: dealId, p_hold_reason_id: row.holdReasonId, p_remarks: 'Migrated from historical data' });
      if (error) { failures.push({ label, error: `hold: ${error.message}` }); continue; }
    }

    if (row.isRejected) {
      const { error } = await supabase.rpc('reject_deal', { p_deal_id: dealId, p_rejection_reason_id: row.rejectionReasonId, p_remarks: 'Migrated from historical data' });
      if (error) { failures.push({ label, error: `rejection: ${error.message}` }); continue; }
    }

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
