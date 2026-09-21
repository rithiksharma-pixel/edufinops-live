// =========================================================
// SHARED — "this number is already a lead" warning on the lead forms
//
// 195 phone numbers sit on more than one lead and none was ever flagged, so
// the same student gets worked twice and counted twice. This checks the
// number as it is typed, via find_leads_by_phone() (deployment/067), which
// matches on the last 10 digits so formatting and a +91 prefix don't matter.
//
// A warning, not a block: a sibling sharing a parent's number, or a genuine
// re-application, is a real reason to create a second lead. The person
// creating it just has to see the first one before they do.
// =========================================================
import { escapeHtml } from './utils.js';

const digits = (v) => String(v || '').replace(/\D/g, '');

/**
 * @param {object} o
 * @param {HTMLInputElement} o.input  the phone field
 * @param {object} o.supabase         the app's own client
 * @param {(leadId: string) => void} [o.onOpen]  opens an existing lead; when
 *   omitted, "Open" links to it in Lead Management instead
 * @returns {{ reset: () => void }}
 */
export function attachDuplicatePhoneCheck({ input, supabase, onOpen }) {
  if (!input) return { reset() {} };
  const box = document.createElement('div');
  box.className = 'dup-phone-warning';
  box.hidden = true;
  box.setAttribute('role', 'status');
  input.insertAdjacentElement('afterend', box);

  let timer; let lastChecked = '';
  const check = async () => {
    const d = digits(input.value);
    if (d.length < 10) { box.hidden = true; lastChecked = ''; return; }
    const key = d.slice(-10);
    if (key === lastChecked) return;
    lastChecked = key;
    const { data, error } = await supabase.rpc('find_leads_by_phone', { p_phone: input.value });
    // The user may have kept typing while we waited; only the latest answer counts.
    if (digits(input.value).slice(-10) !== key) return;
    if (error || !data?.length) { box.hidden = true; return; }

    box.innerHTML = `
      <strong>This number is already on ${data.length === 1 ? 'a lead' : `${data.length} leads`}.</strong>
      Check it isn't the same student before saving.
      <ul>${data.map((l) => `
        <li>
          <span>${escapeHtml(l.student_name)} · ${escapeHtml(l.stage_name || '–')} · ${escapeHtml(l.assigned_rm || 'no RM')} · added ${new Date(l.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
          ${onOpen
            ? `<button type="button" class="dup-open" data-dup-open="${escapeHtml(l.lead_id)}">Open</button>`
            : `<a class="dup-open" href="../../lead-management/public/index.html?openLead=${encodeURIComponent(l.lead_id)}" target="_blank" rel="noopener">Open</a>`}
        </li>`).join('')}</ul>`;
    box.hidden = false;
    box.querySelectorAll('[data-dup-open]').forEach((b) => b.addEventListener('click', () => onOpen(b.dataset.dupOpen)));
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 400); });
  input.addEventListener('blur', () => { clearTimeout(timer); check(); });

  return { reset() { box.hidden = true; box.innerHTML = ''; lastChecked = ''; } };
}
