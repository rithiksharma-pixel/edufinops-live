// =========================================================
// PRESENTATION LAYER — Activities tab (inside the lead drawer)
//
// Pick one of the forms built in Admin → Activity Forms, fill it against
// this lead, and it is stored as an activity. Past activities are listed
// underneath with their answers.
//
// Which forms appear is decided by the form's own targeting: a form with no
// targeting shows on every lead, one targeted at a source or stage only
// shows where it applies. That is what makes a "Referral calling" form
// appear on referral leads and nowhere else.
// =========================================================
import { supabase } from '../config/supabaseClient.js';
import {
  createActivityFormService, NEEDS_OPTIONS, coerceValue, formatValue,
} from '../../../../shared/js/activityFormService.js';

const svc = createActivityFormService(supabase);

export async function initActivitiesTab(panelEl, lead, ctx) {
  const { currentUser, showToast, onSaved } = ctx;

  panelEl.innerHTML = '<p class="empty-state">Loading activities…</p>';

  let forms = [];
  let activities = [];
  try {
    [forms, activities] = await Promise.all([
      svc.formsForLead({ leadSourceId: lead.lead_source_id, leadStageId: lead.current_stage_id }),
      svc.listLeadActivities(lead.id),
    ]);
  } catch (err) {
    console.error(err);
    panelEl.innerHTML = '<p class="empty-state">Could not load activities.</p>';
    return;
  }

  let openFormId = null;

  function render() {
    panelEl.innerHTML = `
      ${forms.length ? `
        <h3 class="act-subhead">Log an activity</h3>
        <div class="act-formpicker">
          ${forms.map((f) => `
            <button type="button" class="act-form-btn ${f.id === openFormId ? 'active' : ''}" data-open="${f.id}">
              <i class="fa-solid ${escapeAttr(f.icon || 'fa-clipboard-list')}"></i>
              ${escapeHtml(f.action_label || f.name)}
            </button>`).join('')}
        </div>
        <div id="actFormHost"></div>
      ` : `
        <p class="empty-state">
          No activity form applies to this lead yet.
          An Admin or Manager can build one in Admin → Activity Forms.
        </p>`}

      <h3 class="act-subhead" style="margin-top:22px;">
        History ${activities.length ? `<span class="act-count">${activities.length}</span>` : ''}
      </h3>
      <div id="actHistory"></div>
    `;

    panelEl.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => {
        openFormId = openFormId === b.dataset.open ? null : b.dataset.open;
        render();
      }));

    if (openFormId) renderForm(forms.find((f) => f.id === openFormId));
    renderHistory();
  }

  function renderForm(form) {
    if (!form) return;
    const host = panelEl.querySelector('#actFormHost');
    if (!form.fields.length) {
      host.innerHTML = '<p class="empty-state">This form has no fields yet.</p>';
      return;
    }

    host.innerHTML = `
      <div class="act-form">
        ${form.description ? `<p class="act-formdesc">${escapeHtml(form.description)}</p>` : ''}
        <div class="form-grid">
          ${form.fields.map(fieldHtml).join('')}
        </div>
        <div class="form-field" style="margin-top:10px;">
          <label>Summary for the timeline (optional)</label>
          <input type="text" id="actSummary" placeholder="One line describing how it went" />
        </div>
        <button class="btn btn-primary" id="actSave" style="margin-top:12px;">
          Save activity
        </button>
      </div>`;

    host.querySelector('#actSave').addEventListener('click', () => save(form, host));
  }

  function fieldHtml(f) {
    const req = f.is_required ? ' *' : '';
    const label = `<label>${escapeHtml(f.label)}${req}</label>`;
    const help = f.help_text ? `<span class="act-help">${escapeHtml(f.help_text)}</span>` : '';
    const ph = f.placeholder ? ` placeholder="${escapeAttr(f.placeholder)}"` : '';
    const key = `data-field="${escapeAttr(f.field_key)}" data-type="${escapeAttr(f.field_type)}"`;
    let control;

    switch (f.field_type) {
      case 'textarea':
        control = `<textarea rows="3" ${key}${ph}></textarea>`;
        break;
      case 'select':
        control = `<select ${key}><option value="">Select…</option>${
          (f.options || []).map((o) => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('')
        }</select>`;
        break;
      case 'multiselect':
        // A native multi-select needs ctrl-click to pick more than one, which
        // nobody discovers on a calling screen. Checkboxes instead.
        control = `<div class="act-checks" ${key}>${
          (f.options || []).map((o) => `
            <label class="act-check"><input type="checkbox" value="${escapeAttr(o)}" /> ${escapeHtml(o)}</label>`).join('')
        }</div>`;
        break;
      case 'checkbox':
        control = `<label class="act-check"><input type="checkbox" ${key} /> Yes</label>`;
        break;
      case 'rating':
        control = `<select ${key}><option value="">–</option>${
          [1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join('')
        }</select>`;
        break;
      case 'number':
        control = `<input type="number" ${key}${ph} />`;
        break;
      case 'date':
        control = `<input type="date" ${key} />`;
        break;
      case 'datetime':
        control = `<input type="datetime-local" ${key} />`;
        break;
      case 'phone':
        control = `<input type="tel" ${key}${ph} />`;
        break;
      case 'email':
        control = `<input type="email" ${key}${ph} />`;
        break;
      default:
        control = `<input type="text" ${key}${ph} />`;
    }
    return `<div class="form-field">${label}${control}${help}</div>`;
  }

  function collect(host) {
    const values = {};
    host.querySelectorAll('[data-field]').forEach((el) => {
      const k = el.dataset.field;
      const t = el.dataset.type;
      if (t === 'multiselect') {
        values[k] = [...el.querySelectorAll('input:checked')].map((i) => i.value);
      } else if (t === 'checkbox') {
        values[k] = el.checked;
      } else {
        values[k] = coerceValue(t, el.value);
      }
    });
    return values;
  }

  async function save(form, host) {
    const btn = host.querySelector('#actSave');
    const values = collect(host);

    // Check required fields here as well as in the trigger, so the message
    // names the field and lands next to it instead of arriving as a
    // database error after a round trip.
    const missing = form.fields.filter((f) => {
      if (!f.is_required) return false;
      const v = values[f.field_key];
      return v === null || v === undefined || v === ''
        || (Array.isArray(v) && v.length === 0)
        || (f.field_type === 'checkbox' && v === false);
    });
    if (missing.length) {
      showToast(`${missing[0].label} is required.`, true);
      return;
    }

    btn.disabled = true;
    try {
      await svc.submitActivity({
        leadId: lead.id,
        formId: form.id,
        values,
        summary: host.querySelector('#actSummary')?.value.trim() || null,
        userId: currentUser.id,
      });
      activities = await svc.listLeadActivities(lead.id);
      openFormId = null;
      render();
      showToast('Activity saved.');
      if (onSaved) onSaved();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save the activity.', true);
    } finally {
      btn.disabled = false;
    }
  }

  function renderHistory() {
    const host = panelEl.querySelector('#actHistory');
    if (!activities.length) {
      host.innerHTML = '<p class="empty-state">Nothing logged against this lead yet.</p>';
      return;
    }
    // Field definitions come from the forms this lead can see; an activity
    // filled from a form that has since been retargeted still renders, just
    // with its keys as labels.
    const byId = new Map(forms.map((f) => [f.id, f]));

    host.innerHTML = activities.map((a) => {
      const form = byId.get(a.form_id);
      const entries = Object.entries(a.values || {});
      return `
        <div class="act-item">
          <div class="act-item-head">
            <strong>${escapeHtml(a.form?.name || 'Activity')}</strong>
            <span class="act-item-meta">
              ${new Date(a.performed_at).toLocaleString('en-IN')}
              ${a.author?.full_name ? `· ${escapeHtml(a.author.full_name)}` : ''}
            </span>
          </div>
          ${a.summary ? `<p class="act-item-summary">${escapeHtml(a.summary)}</p>` : ''}
          ${entries.length ? `<dl class="act-answers">${entries.map(([k, v]) => {
            const fld = form?.fields.find((x) => x.field_key === k);
            return `<div><dt>${escapeHtml(fld?.label || k)}</dt>`
              + `<dd>${escapeHtml(formatValue(fld?.field_type, v))}</dd></div>`;
          }).join('')}</dl>` : ''}
        </div>`;
    }).join('');
  }

  render();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
const escapeAttr = escapeHtml;
