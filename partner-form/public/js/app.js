// =========================================================
// PARTNER LEAD FORM — public, no sign-in.
//
// The token in ?t= is the whole credential and the whole attribution: the
// server decides from it which partner this lead belongs to, so nothing
// the page sends can file a lead under anyone else's name. The page talks
// to exactly two functions (partner_form_context, submit_partner_lead) and
// has no read access to anything else; the anon key it uses grants nothing
// on its own, as every table is behind RLS.
//
// Validation here is for the person filling the form, not for safety — the
// same rules are enforced again in submit_partner_lead, which is the one
// that counts. This copy only exists so a mistyped number is caught before
// a round trip.
// =========================================================

// This page calls exactly two functions and reads no tables, so it posts to
// PostgREST directly instead of pulling in the Supabase SDK. That drops a
// third-party script from the one page in the product most likely to be
// opened on a weak mobile connection — and removes a way for it to break
// that has nothing to do with us. There is no session to manage: a partner
// is not signed in and never will be.
const SUPABASE_URL = window.__ENV__?.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY;

async function rpc(fn, body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { data: null, error: new Error(`HTTP ${res.status}`) };
    return { data: await res.json(), error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

const supabase = { rpc: (fn, body) => rpc(fn, body) };

const token = new URLSearchParams(window.location.search).get('t') || '';

const el = (id) => document.getElementById(id);
const errFor = (name) => document.querySelector(`[data-err="${name}"]`);
const setErr = (name, msg) => { const e = errFor(name); if (e) e.textContent = msg || ''; };
const clearErrors = () => document.querySelectorAll('.pf-err').forEach((e) => (e.textContent = ''));

// ---------------------------------------------------------
// Intake options: the next six intakes, generated rather than hard-coded
// so the list never goes stale on a page nobody revisits.
// ---------------------------------------------------------
function fillIntakes() {
  const sel = el('intake');
  const now = new Date();
  const opts = [];
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  while (opts.length < 6) {
    // Two intakes a year, as the trade uses them.
    if (m <= 1) { opts.push({ label: `Spring ${y}`, month: 1, year: y }); m = 9; }
    else if (m <= 9) { opts.push({ label: `Fall ${y}`, month: 9, year: y }); m = 13; }
    else { y += 1; m = 1; }
  }
  sel.innerHTML = '<option value="">Select…</option>'
    + opts.map((o) => `<option value="${o.month}-${o.year}">${o.label}</option>`).join('');
}

// ₹ in words as they are actually spoken here, so a partner can see at a
// glance that they typed 40,00,000 and not 4,00,000.
function inr(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2).replace(/\.00$/, '')} crore`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(2).replace(/\.00$/, '')} lakh`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function digits(s) { return (s || '').replace(/[^0-9]/g, ''); }

// ---------------------------------------------------------
// Boot: is this link real?
// ---------------------------------------------------------
async function boot() {
  const form = el('pfForm');
  const closed = el('pfClosed');

  if (!token) { el('pfSub').textContent = ''; closed.hidden = false; return; }

  const { data, error } = await supabase.rpc('partner_form_context', { p_token: token });
  const ctx = Array.isArray(data) ? data[0] : null;

  if (error || !ctx || !ctx.is_open) {
    el('pfSub').textContent = '';
    closed.hidden = false;
    return;
  }

  el('pfSub').innerHTML = 'Referrals from <strong></strong>';
  el('pfSub').querySelector('strong').textContent = ctx.consultancy_name;
  el('pfFormNote').textContent =
    'A Zolve relationship manager will call the student, usually the same working day.';
  fillIntakes();
  form.hidden = false;
  wire();
}

function wire() {
  const form = el('pfForm');
  const amount = el('amount');

  amount.addEventListener('input', () => {
    const n = Number(digits(amount.value));
    el('amountWords').textContent = inr(n);
  });

  el('pfAnother').addEventListener('click', () => {
    form.reset();
    el('amountWords').textContent = '';
    clearErrors();
    el('pfDone').hidden = true;
    el('pfDone').classList.remove('is-dup');
    form.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const name = el('student_name').value.trim();
    const phone = el('phone').value.trim();
    const amt = Number(digits(amount.value));
    const email = el('email').value.trim();
    let bad = false;

    if (!name) { setErr('student_name', 'Please enter the student’s name.'); bad = true; }
    if (digits(phone).length < 10) { setErr('phone', 'Please enter a 10-digit mobile number.'); bad = true; }
    if (!(amt > 0)) { setErr('amount', 'Please enter how much loan the student needs.'); bad = true; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('email', 'That email does not look right.'); bad = true; }
    if (bad) {
      document.querySelector('.pf-err:not(:empty)')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    const [im, iy] = (el('intake').value || '-').split('-');
    const btn = el('pfSubmit');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    const { data, error } = await supabase.rpc('submit_partner_lead', {
      p_token: token,
      p_student_name: name,
      p_phone: phone,
      p_email: email || null,
      p_country: el('country').value || null,
      p_course: el('course').value.trim() || null,
      p_university: el('university').value.trim() || null,
      p_amount: amt,
      p_intake_month: im ? Number(im) : null,
      p_intake_year: iy ? Number(iy) : null,
    });

    btn.disabled = false;
    btn.textContent = 'Send to Zolve';

    if (error) {
      setErr('form', 'Could not send just now. Please check your connection and try again.');
      return;
    }

    const res = Array.isArray(data) ? data[0] : null;
    const outcome = res?.outcome;
    const message = res?.message || '';

    // Field-level problems belong next to the field; everything else is a
    // whole-form outcome and gets the result card.
    if (outcome === 'invalid') {
      if (/mobile/i.test(message)) setErr('phone', message);
      else if (/loan amount/i.test(message)) setErr('amount', message);
      else if (/name/i.test(message)) setErr('student_name', message);
      else setErr('form', message);
      return;
    }
    if (outcome === 'rate_limited' || outcome === 'invalid_link') {
      setErr('form', message);
      return;
    }

    el('pfDoneTitle').textContent = outcome === 'duplicate' ? 'Already with us' : 'Thank you';
    el('pfDoneMsg').textContent = message;
    el('pfDone').classList.toggle('is-dup', outcome === 'duplicate');
    el('pfForm').hidden = true;
    el('pfDone').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

boot();
