// =========================================================
// SHARED SERVICE — Custom activity forms
//
// Build a form once ("Referral calling"), give it the fields that campaign
// needs, then fill it against any lead. Each submission is stored as an
// activity on that lead (migration 058).
//
// Exported as a factory taking the app's own supabase client, matching
// trendsService — the form builder lives in admin-dashboard and the fill
// form lives in lead-management, and each app has its own client.
// =========================================================

/** Field types the builder offers, with how each stores its answer. */
export const FIELD_TYPES = [
  { value: 'text',        label: 'Short text',      stores: 'string' },
  { value: 'textarea',    label: 'Paragraph',       stores: 'string' },
  { value: 'number',      label: 'Number',          stores: 'number' },
  { value: 'date',        label: 'Date',            stores: 'string' },
  { value: 'datetime',    label: 'Date and time',   stores: 'string' },
  { value: 'select',      label: 'Choose one',      stores: 'string',  needsOptions: true },
  { value: 'multiselect', label: 'Choose many',     stores: 'array',   needsOptions: true },
  { value: 'checkbox',    label: 'Yes / no',        stores: 'boolean' },
  { value: 'rating',      label: 'Rating (1-5)',    stores: 'number' },
  { value: 'phone',       label: 'Phone',           stores: 'string' },
  { value: 'email',       label: 'Email',           stores: 'string' },
];

export const NEEDS_OPTIONS = new Set(
  FIELD_TYPES.filter((t) => t.needsOptions).map((t) => t.value)
);

/**
 * Turn a label into a field_key the database will accept
 * (^[a-z][a-z0-9_]{0,48}$). The key is what answers are stored under and is
 * never changed afterwards, so labels can be reworded freely without
 * orphaning historical submissions.
 */
export function slugifyKey(label, taken = new Set()) {
  let base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 49);
  if (!base || !/^[a-z]/.test(base)) base = `f_${base}`.slice(0, 49);
  base = base.replace(/_+$/g, '') || 'field';

  let key = base;
  let n = 2;
  while (taken.has(key)) {
    const suffix = `_${n++}`;
    key = base.slice(0, 49 - suffix.length) + suffix;
  }
  return key;
}

/** Coerce a form control's raw value into what the column expects. */
export function coerceValue(fieldType, raw) {
  if (fieldType === 'checkbox') return !!raw;
  if (fieldType === 'multiselect') return Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (fieldType === 'number' || fieldType === 'rating') {
    if (raw === '' || raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(raw ?? '').trim();
  return s === '' ? null : s;
}

/** Render a stored answer for display. */
export function formatValue(fieldType, v) {
  if (v === null || v === undefined) return '—';
  if (fieldType === 'checkbox') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (fieldType === 'rating') return `${v}/5`;
  return String(v);
}

export function createActivityFormService(supabase) {
  // ---------- Definitions ----------

  /** Every form with its fields, newest-ordered by sort_order then name. */
  async function listForms({ activeOnly = false } = {}) {
    let q = supabase
      .from('activity_forms')
      .select(`
        id, name, description, action_label, icon, is_active,
        target_source_ids, target_stage_ids, sort_order, created_at,
        fields:activity_form_fields (
          id, field_key, label, field_type, options, is_required,
          help_text, placeholder, sort_order, is_deleted
        )
      `)
      .eq('is_deleted', false)
      .order('sort_order')
      .order('name');
    if (activeOnly) q = q.eq('is_active', true);

    const { data, error } = await q;
    if (error) throw error;

    // PostgREST cannot filter an embedded table and its parent independently
    // here, so deleted fields are stripped client-side and the survivors
    // sorted — the embed's own order is not guaranteed.
    return (data ?? []).map((f) => ({
      ...f,
      fields: (f.fields ?? [])
        .filter((x) => !x.is_deleted)
        .sort((a, b) => a.sort_order - b.sort_order),
    }));
  }

  /**
   * Forms worth offering on a given lead. A form with no targeting applies
   * everywhere; one with targeting only shows when the lead matches.
   */
  async function formsForLead({ leadSourceId, leadStageId }) {
    const forms = await listForms({ activeOnly: true });
    return forms.filter((f) => {
      const srcOk = !f.target_source_ids?.length || f.target_source_ids.includes(leadSourceId);
      const stgOk = !f.target_stage_ids?.length || f.target_stage_ids.includes(leadStageId);
      return srcOk && stgOk;
    });
  }

  async function createForm(fields, userId) {
    const { data, error } = await supabase
      .from('activity_forms')
      .insert({ ...fields, created_by: userId, updated_by: userId })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  async function updateForm(formId, fields, userId) {
    const { error } = await supabase
      .from('activity_forms')
      .update({ ...fields, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', formId);
    if (error) throw error;
  }

  /** Soft delete, so historical submissions keep pointing at a real form. */
  async function deleteForm(formId) {
    const { error } = await supabase
      .from('activity_forms')
      .update({ is_deleted: true, is_active: false })
      .eq('id', formId);
    if (error) throw error;
  }

  // ---------- Fields ----------

  async function addField(formId, field) {
    const { error } = await supabase.from('activity_form_fields').insert({ form_id: formId, ...field });
    if (error) throw error;
  }

  async function updateField(fieldId, patch) {
    const { error } = await supabase.from('activity_form_fields').update(patch).eq('id', fieldId);
    if (error) throw error;
  }

  /**
   * Soft delete. The answers already recorded under this field_key stay in
   * lead_activities.values, so an export of past submissions is unchanged —
   * but the validation trigger will strip the key from any NEW submission,
   * and re-adding a field with the same key resumes collecting it.
   */
  async function deleteField(fieldId) {
    const { error } = await supabase
      .from('activity_form_fields')
      .update({ is_deleted: true })
      .eq('id', fieldId);
    if (error) throw error;
  }

  /** Persist a reordering as one round trip per moved field. */
  async function reorderFields(orderedIds) {
    await Promise.all(
      orderedIds.map((id, i) =>
        supabase.from('activity_form_fields').update({ sort_order: i + 1 }).eq('id', id))
    );
  }

  // ---------- Submissions ----------

  async function submitActivity({ leadId, formId, values, summary, performedAt, userId }) {
    const { data, error } = await supabase
      .from('lead_activities')
      .insert({
        lead_id: leadId,
        form_id: formId,
        values,
        summary: summary || null,
        performed_at: performedAt || new Date().toISOString(),
        created_by: userId,
      })
      .select('id, performed_at')
      .single();
    if (error) throw error;
    return data;
  }

  async function listLeadActivities(leadId) {
    const { data, error } = await supabase
      .from('lead_activities')
      .select(`
        id, form_id, values, summary, performed_at, created_by,
        form:activity_forms ( name, icon ),
        author:users!lead_activities_created_by_fkey ( full_name )
      `)
      .eq('lead_id', leadId)
      .eq('is_deleted', false)
      .order('performed_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async function updateActivity(activityId, { values, summary }) {
    const { error } = await supabase
      .from('lead_activities')
      .update({ values, summary: summary || null })
      .eq('id', activityId);
    if (error) throw error;
  }

  async function deleteActivity(activityId) {
    const { error } = await supabase
      .from('lead_activities')
      .update({ is_deleted: true })
      .eq('id', activityId);
    if (error) throw error;
  }

  // ---------- Reporting ----------

  /** One row per submission, answers keyed by label — the export shape. */
  async function exportForm(formId, from = null, to = null) {
    const { data, error } = await supabase.rpc('activity_form_export', {
      p_form_id: formId, p_from: from, p_to: to,
    });
    if (error) throw error;
    return data ?? [];
  }

  /** Answer counts per choice field, for "how did the campaign go". */
  async function summariseForm(formId) {
    const { data, error } = await supabase.rpc('activity_form_summary', { p_form_id: formId });
    if (error) throw error;
    return data ?? [];
  }

  return {
    listForms, formsForLead, createForm, updateForm, deleteForm,
    addField, updateField, deleteField, reorderFields,
    submitActivity, listLeadActivities, updateActivity, deleteActivity,
    exportForm, summariseForm,
  };
}
