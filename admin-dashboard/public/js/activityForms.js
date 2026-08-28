// =========================================================
// Activity form builder (Admin / Manager)
//
// Left: the forms. Right: the selected form's settings, its fields, and its
// responses. Field edits save on change rather than behind a Save button —
// a builder where half your work is lost because you navigated away is
// worse than one that writes as you go.
// =========================================================
import { supabase } from './config/supabaseClient.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { guardDestination, applyNavPermissions } from '../../../shared/js/roleAccess.js';
import { showToast } from '../../../shared/js/toast.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';
import { escapeHtml } from '../../../shared/js/utils.js';
import {
  createActivityFormService, FIELD_TYPES, NEEDS_OPTIONS, slugifyKey, formatValue,
} from '../../../shared/js/activityFormService.js';

const svc = createActivityFormService(supabase);
const $ = (id) => document.getElementById(id);

let me = null;
let forms = [];
let selectedId = null;
let sources = [];
let stages = [];
let tab = 'build';

// ---------------------------------------------------------
// Form list
// ---------------------------------------------------------
function renderList() {
  const host = $('afFormList');
  if (!forms.length) {
    host.innerHTML = '<p class="empty-state">No forms yet. Create one to get started.</p>';
    return;
  }
  host.innerHTML = forms.map((f) => `
    <button type="button" class="af-list-item ${f.id === selectedId ? 'active' : ''}" data-form="${f.id}">
      <span class="af-list-name">
        ${escapeHtml(f.name)}
        ${f.is_active ? '' : '<span class="af-badge muted">Inactive</span>'}
      </span>
      <span class="af-list-meta">${f.fields.length} field${f.fields.length === 1 ? '' : 's'}</span>
    </button>`).join('');
}

// ---------------------------------------------------------
// Editor
// ---------------------------------------------------------
function selected() {
  return forms.find((f) => f.id === selectedId) || null;
}

function renderEditor() {
  const f = selected();
  const host = $('afEditor');
  if (!f) {
    host.innerHTML = '<p class="empty-state">Select a form on the left, or create one.</p>';
    return;
  }

  host.innerHTML = `
    <div class="af-editor-head">
      <h2>${escapeHtml(f.name)}</h2>
      <div class="af-editor-actions">
        <button class="btn btn-ghost" id="afDelete"><i class="fa-solid fa-trash"></i> Delete form</button>
      </div>
    </div>

    <div class="report-tabs" role="tablist">
      <button class="report-tab ${tab === 'build' ? 'active' : ''}" data-af-tab="build">Build</button>
      <button class="report-tab ${tab === 'responses' ? 'active' : ''}" data-af-tab="responses">Responses</button>
    </div>

    <div id="afTabBody"></div>
  `;

  $('afDelete').addEventListener('click', onDeleteForm);
  host.querySelectorAll('[data-af-tab]').forEach((b) =>
    b.addEventListener('click', () => { tab = b.dataset.afTab; renderEditor(); }));

  if (tab === 'build') renderBuild(f);
  else renderResponses(f);
}

function renderBuild(f) {
  const body = $('afTabBody');
  const srcOpts = sources.map((s) =>
    `<option value="${s.id}" ${f.target_source_ids?.includes(s.id) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  const stgOpts = stages.map((s) =>
    `<option value="${s.id}" ${f.target_stage_ids?.includes(s.id) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');

  body.innerHTML = `
    <h3 class="af-subhead">Settings</h3>
    <div class="form-grid">
      <div class="form-field"><label>Name</label>
        <input type="text" id="afName" value="${escapeHtml(f.name)}" /></div>
      <div class="form-field"><label>Button label on the lead</label>
        <input type="text" id="afAction" placeholder="e.g. Log referral call"
               value="${escapeHtml(f.action_label ?? '')}" /></div>
      <div class="form-field" style="grid-column:1/-1;"><label>Description</label>
        <input type="text" id="afDesc" placeholder="What is this form for?"
               value="${escapeHtml(f.description ?? '')}" /></div>
      <div class="form-field"><label>Only for these lead sources</label>
        <select id="afSources" multiple size="4">${srcOpts}</select>
        <span class="af-hint">Select none to offer it on every lead.</span></div>
      <div class="form-field"><label>Only at these stages</label>
        <select id="afStages" multiple size="4">${stgOpts}</select>
        <span class="af-hint">Select none to offer it at every stage.</span></div>
      <div class="form-field">
        <label style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" id="afActive" ${f.is_active ? 'checked' : ''} /> Active
        </label>
        <span class="af-hint">Inactive forms stay on past activities but are no longer offered.</span>
      </div>
    </div>
    <button class="btn btn-primary" id="afSaveSettings" style="margin-top:12px;">Save settings</button>

    <h3 class="af-subhead" style="margin-top:26px;">Fields</h3>
    <div id="afFields" class="af-fields"></div>

    <div class="af-addfield">
      <input type="text" id="afNewLabel" placeholder="Field label — e.g. Did they refer anyone?" />
      <select id="afNewType">${FIELD_TYPES.map((t) =>
        `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('')}</select>
      <input type="text" id="afNewOptions" placeholder="Choices, comma separated" hidden />
      <label class="af-inline-check"><input type="checkbox" id="afNewRequired" /> Required</label>
      <button class="btn btn-secondary" id="afAddField"><i class="fa-solid fa-plus"></i> Add field</button>
    </div>
  `;

  renderFields(f);

  $('afSaveSettings').addEventListener('click', onSaveSettings);
  $('afAddField').addEventListener('click', onAddField);
  const typeSel = $('afNewType');
  const optInput = $('afNewOptions');
  const syncOptions = () => { optInput.hidden = !NEEDS_OPTIONS.has(typeSel.value); };
  typeSel.addEventListener('change', syncOptions);
  syncOptions();
}

function renderFields(f) {
  const host = $('afFields');
  if (!f.fields.length) {
    host.innerHTML = '<p class="empty-state">No fields yet. Add the first one below.</p>';
    return;
  }
  host.innerHTML = f.fields.map((fld, i) => `
    <div class="af-field-row" data-field="${fld.id}">
      <div class="af-field-move">
        <button class="icon-btn" data-move="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up"><i class="fa-solid fa-chevron-up"></i></button>
        <button class="icon-btn" data-move="down" ${i === f.fields.length - 1 ? 'disabled' : ''} aria-label="Move down"><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <div class="af-field-main">
        <input type="text" class="af-field-label" data-edit="label" value="${escapeHtml(fld.label)}" />
        <div class="af-field-meta">
          <span class="af-badge">${escapeHtml(FIELD_TYPES.find((t) => t.value === fld.field_type)?.label || fld.field_type)}</span>
          <code class="af-key">${escapeHtml(fld.field_key)}</code>
          <label class="af-inline-check"><input type="checkbox" data-edit="is_required" ${fld.is_required ? 'checked' : ''} /> Required</label>
        </div>
        ${NEEDS_OPTIONS.has(fld.field_type)
          ? `<input type="text" class="af-field-options" data-edit="options"
                    value="${escapeHtml((fld.options || []).join(', '))}"
                    placeholder="Choices, comma separated" />`
          : ''}
      </div>
      <button class="icon-btn af-field-del" data-del aria-label="Remove field"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');

  host.querySelectorAll('.af-field-row').forEach((row) => {
    const id = row.dataset.field;
    row.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', () => moveField(id, b.dataset.move)));
    row.querySelector('[data-del]').addEventListener('click', () => onDeleteField(id));
    row.querySelectorAll('[data-edit]').forEach((el) =>
      el.addEventListener('change', () => onEditField(id, el)));
  });
}

// ---------------------------------------------------------
// Responses
// ---------------------------------------------------------
async function renderResponses(f) {
  const body = $('afTabBody');
  body.innerHTML = '<p class="empty-state">Loading responses…</p>';
  try {
    const [rows, summary] = await Promise.all([svc.exportForm(f.id), svc.summariseForm(f.id)]);
    if (!rows.length) {
      body.innerHTML = '<p class="empty-state">No one has filled this form yet.</p>';
      return;
    }

    const grouped = summary.reduce((acc, r) => {
      (acc[r.label] ||= []).push(r);
      return acc;
    }, {});

    body.innerHTML = `
      <div class="af-resp-head">
        <span>${rows.length} response${rows.length === 1 ? '' : 's'}</span>
        <button class="btn btn-secondary" id="afExport"><i class="fa-solid fa-download"></i> Download CSV</button>
      </div>

      ${Object.keys(grouped).length ? `
        <h3 class="af-subhead">Answer breakdown</h3>
        <div class="af-summary">
          ${Object.entries(grouped).map(([label, items]) => {
            const total = items.reduce((s, i) => s + Number(i.responses), 0);
            return `<div class="af-summary-card">
              <h4>${escapeHtml(label)}</h4>
              ${items.map((i) => {
                const share = total ? Math.round((Number(i.responses) / total) * 100) : 0;
                return `<div class="af-bar-row">
                  <span class="af-bar-label">${escapeHtml(i.answer)}</span>
                  <span class="af-bar"><span style="width:${share}%"></span></span>
                  <span class="af-bar-count">${i.responses}</span>
                </div>`;
              }).join('')}
            </div>`;
          }).join('')}
        </div>` : ''}

      <h3 class="af-subhead">Responses</h3>
      <div class="af-tablewrap"><table class="af-table">
        <thead><tr>
          <th>When</th><th>Student</th><th>Phone</th><th>Owner</th><th>Stage</th><th>Filled by</th>
          ${f.fields.map((x) => `<th>${escapeHtml(x.label)}</th>`).join('')}
        </tr></thead>
        <tbody>${rows.slice(0, 200).map((r) => `<tr>
          <td>${new Date(r.performed_at).toLocaleString('en-IN')}</td>
          <td>${escapeHtml(r.student_name ?? '')}</td>
          <td>${escapeHtml(r.student_phone ?? '')}</td>
          <td>${escapeHtml(r.owner ?? '')}</td>
          <td>${escapeHtml(r.stage ?? '')}</td>
          <td>${escapeHtml(r.filled_by ?? '')}</td>
          ${f.fields.map((x) =>
            `<td>${escapeHtml(formatValue(x.field_type, r.answers?.[x.label]))}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>
      ${rows.length > 200 ? `<p class="af-hint">Showing the newest 200 of ${rows.length}. The CSV has them all.</p>` : ''}
    `;

    $('afExport').addEventListener('click', () => exportCsv(f, rows));
  } catch (err) {
    console.error(err);
    body.innerHTML = '<p class="empty-state">Could not load responses.</p>';
  }
}

function exportCsv(f, rows) {
  const head = ['When', 'Student', 'Phone', 'Owner', 'Stage', 'Filled by', 'Summary',
    ...f.fields.map((x) => x.label)];
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => [
    new Date(r.performed_at).toISOString(), r.student_name, r.student_phone,
    r.owner, r.stage, r.filled_by, r.summary,
    ...f.fields.map((x) => formatValue(x.field_type, r.answers?.[x.label])),
  ].map(cell).join(','));

  // BOM so Excel opens the file as UTF-8 rather than mangling names.
  const blob = new Blob(['﻿' + [head.map(cell).join(','), ...body].join('\r\n')],
    { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${f.name.replace(/[^\w -]/g, '')}-responses.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------
// Actions
// ---------------------------------------------------------
async function reload(keepSelection = true) {
  forms = await svc.listForms();
  if (!keepSelection || !forms.some((f) => f.id === selectedId)) {
    selectedId = forms[0]?.id ?? null;
  }
  renderList();
  renderEditor();
}

async function onNewForm() {
  const name = prompt('Name this form — e.g. "Referral calling"');
  if (!name?.trim()) return;
  try {
    const id = await svc.createForm({ name: name.trim(), sort_order: forms.length + 1 }, me.id);
    selectedId = id;
    tab = 'build';
    await reload();
    showToast('Form created. Add its fields below.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not create the form.', true);
  }
}

async function onSaveSettings() {
  const f = selected();
  if (!f) return;
  const pick = (id) => [...$(id).selectedOptions].map((o) => o.value);
  try {
    await svc.updateForm(f.id, {
      name: $('afName').value.trim() || f.name,
      action_label: $('afAction').value.trim() || null,
      description: $('afDesc').value.trim() || null,
      is_active: $('afActive').checked,
      target_source_ids: pick('afSources'),
      target_stage_ids: pick('afStages'),
    }, me.id);
    await reload();
    showToast('Settings saved.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not save.', true);
  }
}

async function onDeleteForm() {
  const f = selected();
  if (!f) return;
  if (!confirm(`Delete "${f.name}"? Past submissions stay on their leads, but nobody can fill it again.`)) return;
  try {
    await svc.deleteForm(f.id);
    selectedId = null;
    await reload(false);
    showToast('Form deleted.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not delete the form.', true);
  }
}

function parseOptions(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function onAddField() {
  const f = selected();
  if (!f) return;
  const label = $('afNewLabel').value.trim();
  const type = $('afNewType').value;
  if (!label) { showToast('Give the field a label.', true); return; }

  const options = NEEDS_OPTIONS.has(type) ? parseOptions($('afNewOptions').value) : [];
  if (NEEDS_OPTIONS.has(type) && options.length === 0) {
    showToast('A choice field needs at least one choice.', true);
    return;
  }

  // Keys must be unique per form and are never reused, so deleted fields
  // count as taken — re-adding the same label must not silently overwrite
  // the answers already stored under that key.
  const taken = new Set((f.fields || []).map((x) => x.field_key));
  try {
    await svc.addField(f.id, {
      field_key: slugifyKey(label, taken),
      label,
      field_type: type,
      options,
      is_required: $('afNewRequired').checked,
      sort_order: f.fields.length + 1,
    });
    $('afNewLabel').value = '';
    $('afNewOptions').value = '';
    $('afNewRequired').checked = false;
    await reload();
    showToast('Field added.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not add the field.', true);
  }
}

async function onEditField(fieldId, el) {
  const key = el.dataset.edit;
  const patch = key === 'is_required' ? { is_required: el.checked }
    : key === 'options' ? { options: parseOptions(el.value) }
    : { label: el.value.trim() };

  if (key === 'options' && patch.options.length === 0) {
    showToast('A choice field needs at least one choice.', true);
    await reload();
    return;
  }
  if (key === 'label' && !patch.label) {
    showToast('A field needs a label.', true);
    await reload();
    return;
  }
  try {
    await svc.updateField(fieldId, patch);
    await reload();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not update the field.', true);
    await reload();
  }
}

async function onDeleteField(fieldId) {
  const f = selected();
  const fld = f?.fields.find((x) => x.id === fieldId);
  if (!fld) return;
  if (!confirm(`Remove "${fld.label}"? Answers already recorded stay in past responses.`)) return;
  try {
    await svc.deleteField(fieldId);
    await reload();
    showToast('Field removed.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not remove the field.', true);
  }
}

async function moveField(fieldId, dir) {
  const f = selected();
  if (!f) return;
  const ids = f.fields.map((x) => x.id);
  const i = ids.indexOf(fieldId);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await svc.reorderFields(ids);
    await reload();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not reorder.', true);
  }
}

// ---------------------------------------------------------
/**
 * Same shape as requireAdmin() in app.js, widened to Managers: building a
 * calling form is a campaign decision, not a platform-administration one.
 * RLS enforces the same rule server-side.
 */
async function requireAdminOrManager() {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) throw new Error('Please sign in first.');
  const { data, error } = await supabase
    .from('users').select('full_name, roles(name)').eq('id', auth.user.id).single();
  if (error) throw error;
  const role = data.roles?.name;
  return { id: auth.user.id, full_name: data.full_name, role };
}

async function bootstrap() {
  me = await requireAdminOrManager();
  $('userName').textContent = me.full_name;
  $('userRole').textContent = me.role ?? '–';
  $('avatar').textContent = (me.full_name || '?').charAt(0).toUpperCase();
  if (!guardDestination(me, 'activity-forms')) return;
  applyNavPermissions(me.role);
  mountTopbar({ app: 'admin-dashboard', user: { ...me, fullName: me.full_name } });

  if (!['Admin', 'Manager'].includes(me.role)) {
    document.querySelector('.af-layout').innerHTML =
      '<p class="empty-state">Activity forms are managed by Admins and Managers.</p>';
    $('btnNewForm').hidden = true;
    return;
  }

  const [src, stg] = await Promise.all([
    supabase.from('lead_sources').select('id, name').eq('is_deleted', false).order('name'),
    supabase.from('lead_stages').select('id, name').eq('is_deleted', false).order('sequence_order'),
  ]);
  sources = src.data ?? [];
  stages = stg.data ?? [];

  $('btnNewForm').addEventListener('click', onNewForm);
  $('afFormList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-form]');
    if (!btn) return;
    selectedId = btn.dataset.form;
    tab = 'build';
    renderList();
    renderEditor();
  });

  await reload(false);
}

guardBootstrap(bootstrap, 'Activity Forms');
