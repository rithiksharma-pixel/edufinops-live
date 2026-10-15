// =========================================================
// SHARED — The search box in the top bar, on every page.
//
// The thing it exists for: a lender sends a list of their own login IDs
// ("A2608215209" from Credila, "BANEE01184659" from Avanse) and asks which
// of them are ours. That number was always in the CRM, on the bank case as
// Login ID, but nothing searched it — the lead list searched names, and the
// ID was reachable only by opening a lead and clicking into its Login
// stage. So the only way to answer was to guess at student names, which for
// a "Rahul" or an "Ajay" cannot work: there are sixty of them.
//
// One box, four kinds of input, no mode to pick. crm_search() (072) works
// out what was pasted — login ID, phone, name or email — and says which on
// every row, because "why did this match?" is the first question when a
// search returns someone you did not expect. A phone is matched on its last
// ten digits, so a number copied with +91 and spaces still lands.
//
// Where a hit opens depends on who is asking: internal staff go to the lead
// in Lead Management, a bank's own officer to that case in Lender Pipeline,
// since a Lender has no Lead Management to go to. Everything either of them
// can see is decided in the database by crm_search itself, not here — this
// module renders whatever comes back.
// =========================================================

import { escapeHtml } from './utils.js';
import { ROLES } from './roleAccess.js';

const LEAD_PATH = '/lead-management/public/index.html';
const LENDER_PATH = '/lender-pipeline/public/index.html';
const DEBOUNCE_MS = 220;
const MIN_CHARS = 2;

let wired = false;
let client = null;
let viewerRole = null;
let seq = 0;

/**
 * Mount the box into its placeholder in the top bar.
 * Idempotent: mountTopbar re-renders on every breadcrumb change, and the
 * box must not lose what is typed in it when that happens.
 *
 * @param {HTMLElement} host    the placeholder div
 * @param {{supabase:object, role:string}} opts
 */
export function mountGlobalSearch(host, { supabase, role }) {
  if (!host || !supabase) return;
  client = supabase;
  viewerRole = role || null;

  // Re-render of the topbar replaces the host node, so the markup has to be
  // re-created, but the module-level listeners are added once.
  host.innerHTML = `
    <div class="zt-search-field">
      <i class="fa-solid fa-magnifying-glass zt-search-icon"></i>
      <input type="search" class="zt-search-input" autocomplete="off" spellcheck="false"
             placeholder="Search name, phone or login ID"
             aria-label="Search leads by name, phone, email or lender login ID"
             role="combobox" aria-expanded="false" aria-controls="ztSearchResults" />
      <kbd class="zt-search-hint">/</kbd>
    </div>
    <div class="zt-search-results" id="ztSearchResults" role="listbox" hidden></div>
  `;

  const input = host.querySelector('.zt-search-input');
  const panel = host.querySelector('.zt-search-results');

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < MIN_CHARS) { close(panel, input); return; }
    timer = setTimeout(() => run(q, panel, input), DEBOUNCE_MS);
  });

  // Enter runs immediately: someone pasting a login ID wants the answer now,
  // not after the debounce.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(panel, input); input.blur(); return; }
    if (e.key === 'Enter') {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length >= MIN_CHARS) run(q, panel, input);
      return;
    }
    if (e.key === 'ArrowDown') {
      const first = panel.querySelector('.zt-search-row');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });

  panel.addEventListener('keydown', (e) => {
    const rows = [...panel.querySelectorAll('.zt-search-row')];
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i < rows.length - 1) { e.preventDefault(); rows[i + 1].focus(); }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i <= 0) input.focus(); else rows[i - 1].focus();
    }
    if (e.key === 'Escape') { close(panel, input); input.focus(); }
  });

  if (!wired) {
    wired = true;

    // "/" focuses the box from anywhere, the way it does in most tools —
    // except while something else is being typed into, where "/" is a slash.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      const box = document.querySelector('.zt-search-input');
      if (!box) return;
      e.preventDefault();
      box.focus();
      box.select();
    });

    document.addEventListener('click', (e) => {
      const wrap = document.querySelector('.zt-search');
      if (!wrap || wrap.contains(e.target)) return;
      const p = wrap.querySelector('.zt-search-results');
      const inp = wrap.querySelector('.zt-search-input');
      if (p) close(p, inp);
    });
  }
}

function close(panel, input) {
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  if (input) input.setAttribute('aria-expanded', 'false');
}

function open(panel, input, html) {
  panel.innerHTML = html;
  panel.hidden = false;
  if (input) input.setAttribute('aria-expanded', 'true');
}

async function run(q, panel, input) {
  // Every query carries a ticket. Typing "9639" then "9639579237" fires two
  // searches, and the slower one must not overwrite the newer answer.
  const ticket = ++seq;
  open(panel, input, '<div class="zt-search-note">Searching…</div>');

  const { data, error } = await client.rpc('crm_search', { p_q: q, p_limit: 12 });
  if (ticket !== seq) return;

  if (error) {
    open(panel, input, `<div class="zt-search-note err">Could not search right now. ${escapeHtml(error.message || '')}</div>`);
    return;
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    open(panel, input, `<div class="zt-search-note">Nothing matches “${escapeHtml(q)}”.</div>`);
    return;
  }
  open(panel, input, rows.map(rowHtml).join(''));
  panel.querySelectorAll('.zt-search-row').forEach((el) => {
    el.addEventListener('click', () => { window.location.href = el.dataset.href; });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.location.href = el.dataset.href; }
    });
  });
}

function hrefFor(r) {
  if (viewerRole === ROLES.LENDER && r.deal_id) {
    return `${LENDER_PATH}?openDeal=${encodeURIComponent(r.deal_id)}`;
  }
  return `${LEAD_PATH}?openLead=${encodeURIComponent(r.lead_id)}`;
}

function rowHtml(r) {
  // The matched field is shown first and in full. On a login-ID search it is
  // the only part the person actually has in hand, and seeing it echoed back
  // is how they know this row is the case they were asked about.
  const badge = r.matched_on ? `<span class="zt-search-badge">${escapeHtml(r.matched_on)}</span>` : '';
  const lead = r.matched_on === 'Login ID' && r.login_id
    ? `<code>${escapeHtml(r.login_id)}</code>`
    : escapeHtml(r.student_phone || '');

  const meta = [
    r.consultancy ? escapeHtml(r.consultancy) : null,
    r.rm_name ? `RM ${escapeHtml(r.rm_name)}` : null,
    r.bd_name ? `BD ${escapeHtml(r.bd_name)}` : null,
    r.lender_name ? escapeHtml(r.lender_name) : null,
  ].filter(Boolean).join(' · ');

  return `
    <div class="zt-search-row" role="option" tabindex="0" data-href="${escapeHtml(hrefFor(r))}">
      <div class="zt-search-row-top">
        <strong>${escapeHtml(r.student_name || 'Unnamed lead')}</strong>
        ${badge}
        <span class="zt-search-stage">${escapeHtml(r.lead_stage || '')}</span>
      </div>
      <div class="zt-search-row-sub">${lead}${meta ? ` · ${meta}` : ''}</div>
    </div>
  `;
}
