// =========================================================
// Weekly Business Review — page controller
//
// One button runs the whole thing: fetch → compute → charts → render →
// store, with a visible step tracker. Exports to .pptx (PptxGenJS) and to
// PDF (the browser's own print pipeline against a print stylesheet, which
// gives selectable text and real page breaks rather than a screenshot).
// =========================================================
import { supabase } from './config/supabaseClient.js';
import { getCurrentUser } from './services/authService.js';
import {
  fetchReviewData, saveReview, listReviews, getReview, deleteReview,
  listTargets, saveTarget,
} from './services/weeklyReviewService.js';
import {
  BRAND, num, pct, growth, growthText,
  buildSections, buildChartConfigs, renderChart,
} from './reviewDeck.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';

// Charts are rendered at the aspect ratio the slide gives them, so the pptx
// never has to stretch one to fit. 1280x560 is 2.29:1, which fits a full
// slide width under the header band with room to spare.
const CHART_W = 1280;
const CHART_H = 560;

const STEPS = [
  ['fetch', 'Fetching the latest CRM data'],
  ['compute', 'Computing weekly and monthly movements'],
  ['charts', 'Rendering charts'],
  ['build', 'Laying out the deck'],
  ['store', 'Saving to Weekly Reviews'],
];

let currentUser = null;
let lastPayload = null;   // raw RPC JSON
let lastSections = null;  // built section model
let lastCharts = null;    // {key: {dataUrl,width,height}}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------
// Progress
// ---------------------------------------------------------
function renderSteps() {
  $('wrSteps').innerHTML = STEPS.map(([k, label]) =>
    `<li class="wr-step" data-step="${k}"><span class="wr-step-dot"></span>${esc(label)}</li>`).join('');
}
function setStep(key, state) {
  const el = document.querySelector(`.wr-step[data-step="${key}"]`);
  if (el) el.className = `wr-step ${state}`;
}
function setProgress(pctDone, label) {
  $('wrBar').style.width = `${pctDone}%`;
  $('wrProgressLabel').textContent = label;
}
// Let the browser paint between steps, so the tracker actually animates
// instead of jumping from 0 to 100 when the thread frees up.
const breathe = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------
// Generate
// ---------------------------------------------------------
async function generate() {
  const btn = $('btnGenerate');
  btn.disabled = true;
  $('wrProgress').hidden = false;
  $('wrDeck').innerHTML = '';
  $('wrExports').hidden = true;
  renderSteps();

  const weekEnd = $('wrWeekEnd').value || null;

  try {
    setStep('fetch', 'active'); setProgress(8, 'Fetching the latest CRM data…'); await breathe();
    const data = await fetchReviewData(weekEnd);
    lastPayload = data;
    setStep('fetch', 'done');

    setStep('compute', 'active'); setProgress(28, 'Computing movements…'); await breathe();
    const configs = buildChartConfigs(data);
    setStep('compute', 'done');

    setStep('charts', 'active'); setProgress(45, 'Rendering charts…'); await breathe();
    const charts = {};
    const keys = Object.keys(configs);
    for (let i = 0; i < keys.length; i++) {
      charts[keys[i]] = await renderChart(configs[keys[i]], CHART_W, CHART_H);
      setProgress(45 + Math.round((i / keys.length) * 25), `Rendering charts… (${i + 1}/${keys.length})`);
    }
    lastCharts = charts;
    setStep('charts', 'done');

    setStep('build', 'active'); setProgress(78, 'Laying out the deck…'); await breathe();
    const sections = buildSections(data, charts);
    lastSections = sections;
    renderDeck(sections, data);
    setStep('build', 'done');

    setStep('store', 'active'); setProgress(92, 'Saving…'); await breathe();
    const title = `Weekly Business Review — week ending ${data.meta.week_end}`;
    try {
      await saveReview({
        weekStart: data.meta.week_start, weekEnd: data.meta.week_end,
        title, payload: data, userId: currentUser.id,
      });
      setStep('store', 'done');
      await refreshReviewList();
    } catch (storeErr) {
      // A failed save must not cost the user the deck they just waited for.
      console.error(storeErr);
      setStep('store', 'failed');
      toast(`Deck ready, but it could not be saved to Weekly Reviews: ${storeErr.message}`, true);
    }

    setProgress(100, 'Done');
    $('wrExports').hidden = false;
    $('wrDeck').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    STEPS.forEach(([k]) => {
      const el = document.querySelector(`.wr-step[data-step="${k}"]`);
      if (el && !el.classList.contains('done')) setStep(k, 'failed');
    });
    setProgress(100, 'Generation failed');
    toast(err.message || 'Could not generate the review.', true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------
// On-screen deck
// ---------------------------------------------------------
function tableHtml(t) {
  if (!t || !t.rows?.length) return '';
  return `
    ${t.title ? `<h4 class="wr-subhead">${esc(t.title)}</h4>` : ''}
    <div class="wr-tablewrap"><table class="wr-table">
      <thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c) => {
        const s = String(c ?? '');
        const cls = s.startsWith('+') ? 'up' : (s.startsWith('-') && s.endsWith('%') ? 'down' : '');
        return `<td class="${cls}">${esc(s === '' ? '—' : s)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

function renderDeck(sections, data) {
  const host = $('wrDeck');
  host.innerHTML = sections.map((s, i) => `
    <section class="wr-slide" id="slide-${s.id}">
      <div class="wr-slide-head">
        <span class="wr-slide-no">${String(i + 1).padStart(2, '0')}</span>
        <div>
          <h2>${esc(s.title)}</h2>
          ${s.subtitle ? `<p class="wr-slide-sub">${esc(s.subtitle)}</p>` : ''}
        </div>
      </div>

      ${s.awaiting ? `<div class="wr-awaiting">
        <strong>Awaiting input.</strong> ${esc(s.awaitingReason || '')}
        The layout below is ready to fill in.
      </div>` : ''}

      ${s.kpis ? `<div class="wr-kpis">${s.kpis.map((k) => `
        <div class="wr-kpi">
          <span class="wr-kpi-label">${esc(k.label)}</span>
          <span class="wr-kpi-value">${esc(k.value)}</span>
          <span class="wr-kpi-delta ${k.delta?.startsWith('+') ? 'up' : (k.delta?.startsWith('-') ? 'down' : '')}">${esc(k.delta || '')}</span>
        </div>`).join('')}</div>` : ''}

      ${s.lists ? s.lists.map((l) => `
        <h4 class="wr-subhead tone-${l.tone}">${esc(l.heading)}</h4>
        ${l.items.length
          ? `<ul class="wr-list tone-${l.tone}">${l.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
          : '<p class="wr-none">Nothing flagged this week.</p>'}
      `).join('') : ''}

      ${s.chart ? `<img class="wr-chart" src="${s.chart.dataUrl}" alt="${esc(s.title)} chart" />` : ''}
      ${tableHtml(s.table)}
      ${s.chart2 ? `<img class="wr-chart" src="${s.chart2.dataUrl}" alt="${esc(s.title)} second chart" />` : ''}
      ${tableHtml(s.table2)}

      ${s.notes?.length ? `<ul class="wr-notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </section>`).join('');

  $('wrDeckMeta').textContent =
    `Week ${data.meta.week_start} to ${data.meta.week_end} · generated ${new Date(data.meta.generated_at).toLocaleString('en-IN')}`;
}

// ---------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------
async function exportPptx() {
  if (!lastSections) return;
  if (typeof PptxGenJS === 'undefined') {
    toast('The PowerPoint library did not load. Check the network and reload.', true);
    return;
  }
  const btn = $('btnPptx');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Building…';

  try {
    // eslint-disable-next-line no-undef
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    pptx.author = 'Zolve Tangent';
    pptx.company = 'Zolve Tangent';
    pptx.title = `Weekly Business Review — ${lastPayload.meta.week_end}`;

    const W = 13.33, H = 7.5;

    // Title slide
    const t = pptx.addSlide();
    t.background = { color: BRAND.navy };
    t.addText('Weekly Business Review', {
      x: 0.9, y: 2.5, w: W - 1.8, h: 1, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Inter',
    });
    t.addText(`Week ending ${lastPayload.meta.week_end}`, {
      x: 0.9, y: 3.5, w: W - 1.8, h: 0.5, fontSize: 18, color: BRAND.soft, fontFace: 'Inter',
    });
    t.addText('Zolve Tangent', {
      x: 0.9, y: H - 1.0, w: 5, h: 0.4, fontSize: 13, color: BRAND.soft, fontFace: 'Inter',
    });

    for (const s of lastSections) {
      addSectionSlides(pptx, s, W, H);
    }

    await pptx.writeFile({ fileName: `Weekly-Business-Review-${lastPayload.meta.week_end}.pptx` });
    toast('PowerPoint downloaded.');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not build the PowerPoint.', true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/** Header band shared by every content slide. */
function slideHeader(slide, title, W) {
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.85, fill: { color: BRAND.navy } });
  slide.addText(title, {
    x: 0.45, y: 0.14, w: W - 0.9, h: 0.55, fontSize: 22, bold: true, color: 'FFFFFF', fontFace: 'Inter',
  });
}

const TABLE_BASE = {
  fontSize: 10, fontFace: 'Inter', color: BRAND.ink, border: { type: 'solid', color: BRAND.line, pt: 0.5 },
  autoPage: false,
};

/**
 * A section can need more than one slide: a chart and a 15-row table do not
 * both fit at a readable size. Split rather than shrink.
 */
function addSectionSlides(pptx, s, W, H) {
  const first = pptx.addSlide();
  slideHeader(first, s.title, W);
  let y = 1.05;

  if (s.awaiting) {
    first.addShape('rect', { x: 0.45, y, w: W - 0.9, h: 0.95, fill: { color: 'FEF3C7' } });
    first.addText(`Awaiting input — ${s.awaitingReason || ''}`, {
      x: 0.6, y: y + 0.1, w: W - 1.2, h: 0.75, fontSize: 10, color: '92400E', fontFace: 'Inter', valign: 'top',
    });
    y += 1.1;
  }

  if (s.kpis) {
    const cw = (W - 0.9 - 0.3 * (s.kpis.length - 1)) / s.kpis.length;
    s.kpis.forEach((k, i) => {
      const x = 0.45 + i * (cw + 0.3);
      first.addShape('rect', { x, y, w: cw, h: 1.15, fill: { color: 'F4F7FC' } });
      first.addText(k.label, { x: x + 0.15, y: y + 0.1, w: cw - 0.3, h: 0.3, fontSize: 9, color: BRAND.muted, fontFace: 'Inter' });
      first.addText(k.value, { x: x + 0.15, y: y + 0.36, w: cw - 0.3, h: 0.45, fontSize: 22, bold: true, color: BRAND.navy, fontFace: 'Inter' });
      first.addText(k.delta || '', {
        x: x + 0.15, y: y + 0.82, w: cw - 0.3, h: 0.25, fontSize: 10, fontFace: 'Inter',
        color: (k.delta || '').startsWith('+') ? BRAND.good : ((k.delta || '').startsWith('-') ? BRAND.bad : BRAND.muted),
      });
    });
    y += 1.4;
  }

  if (s.lists) {
    for (const l of s.lists) {
      if (y > H - 1.3) break;
      const tone = l.tone === 'good' ? BRAND.good : (l.tone === 'bad' ? BRAND.bad : BRAND.warn);
      first.addText(l.heading, { x: 0.45, y, w: W - 0.9, h: 0.28, fontSize: 12, bold: true, color: tone, fontFace: 'Inter' });
      y += 0.3;
      const items = l.items.length ? l.items : ['Nothing flagged this week.'];
      const h = Math.min(items.length * 0.26 + 0.1, H - y - 0.35);
      first.addText(items.map((x) => ({ text: x, options: { bullet: true, breakLine: true } })), {
        x: 0.6, y, w: W - 1.2, h, fontSize: 10, color: BRAND.ink, fontFace: 'Inter', valign: 'top',
      });
      y += h + 0.12;
    }
  }

  if (s.notes?.length && y < H - 0.8) {
    first.addText(s.notes.map((n) => ({ text: n, options: { bullet: true, breakLine: true } })), {
      x: 0.45, y, w: W - 0.9, h: Math.min(s.notes.length * 0.24 + 0.1, H - y - 0.25),
      fontSize: 9, color: BRAND.muted, fontFace: 'Inter', valign: 'top',
    });
  }

  // Charts get their own slide, scaled from their real pixel dimensions so
  // the picture keeps its aspect ratio. Fitting a 2.3:1 chart into whatever
  // vertical gap was left over is what made the earlier deck look stretched.
  for (const chart of [s.chart, s.chart2]) {
    if (!chart) continue;
    const slide = pptx.addSlide();
    slideHeader(slide, s.title, W);
    const top = 1.05, bottom = 0.35;
    const maxW = W - 0.9, maxH = H - top - bottom;
    const ratio = chart.height / chart.width;
    let w = maxW, h = w * ratio;
    if (h > maxH) { h = maxH; w = h / ratio; }
    slide.addImage({ data: chart.dataUrl, x: (W - w) / 2, y: top + (maxH - h) / 2, w, h });
  }

  // Tables get their own slide so they stay legible.
  for (const tbl of [s.table, s.table2]) {
    if (!tbl?.rows?.length) continue;
    const CHUNK = 16;
    for (let i = 0; i < tbl.rows.length; i += CHUNK) {
      const slide = pptx.addSlide();
      const part = tbl.rows.length > CHUNK ? ` (${Math.floor(i / CHUNK) + 1})` : '';
      slideHeader(slide, `${s.title}${tbl.title ? ` — ${tbl.title}` : ''}${part}`, W);
      const head = tbl.head.map((h) => ({
        text: h, options: { bold: true, color: 'FFFFFF', fill: { color: BRAND.blue } },
      }));
      const body = tbl.rows.slice(i, i + CHUNK).map((r) => r.map((c) => ({
        text: String(c ?? '') === '' ? '' : String(c),
        options: {
          color: String(c ?? '').startsWith('+') ? BRAND.good
            : (String(c ?? '').startsWith('-') && String(c).endsWith('%') ? BRAND.bad : BRAND.ink),
        },
      })));
      // No forced rowH: a fixed height clips long owner or consultancy
      // names once a table has more than a few columns. Let the rows size
      // themselves and keep the font small enough that 16 always fit.
      slide.addTable([head, ...body], {
        ...TABLE_BASE, x: 0.4, y: 1.05, w: W - 0.8, valign: 'middle',
      });
    }
  }
}

// ---------------------------------------------------------
// PDF — the browser's print pipeline against the print stylesheet.
// Real text, real page breaks, and no extra dependency.
// ---------------------------------------------------------
function exportPdf() {
  if (!lastSections) return;
  document.body.classList.add('wr-printing');
  const restore = () => {
    document.body.classList.remove('wr-printing');
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
  // Safari never fires afterprint in some versions; clear defensively.
  setTimeout(restore, 60000);
}

// ---------------------------------------------------------
// Stored reviews
// ---------------------------------------------------------
async function refreshReviewList() {
  const host = $('wrHistory');
  try {
    const rows = await listReviews();
    if (!rows.length) {
      host.innerHTML = '<p class="wr-none">No reviews generated yet.</p>';
      return;
    }
    host.innerHTML = rows.map((r) => `
      <div class="wr-hist-row">
        <div>
          <strong>${esc(r.title)}</strong>
          <span class="wr-hist-meta">${esc(r.week_start)} → ${esc(r.week_end)}
            · ${new Date(r.generated_at).toLocaleString('en-IN')}
            ${r.users?.full_name ? `· ${esc(r.users.full_name)}` : ''}</span>
        </div>
        <div class="wr-hist-actions">
          <button class="btn btn-ghost" data-open="${r.id}">Open</button>
          <button class="btn btn-ghost" data-del="${r.id}">Delete</button>
        </div>
      </div>`).join('');
  } catch (err) {
    console.error(err);
    host.innerHTML = '<p class="wr-none">Could not load saved reviews.</p>';
  }
}

async function openStored(id) {
  try {
    const row = await getReview(id);
    lastPayload = row.payload;
    const configs = buildChartConfigs(row.payload);
    const charts = {};
    for (const k of Object.keys(configs)) charts[k] = await renderChart(configs[k], CHART_W, CHART_H);
    lastCharts = charts;
    lastSections = buildSections(row.payload, charts);
    renderDeck(lastSections, row.payload);
    $('wrExports').hidden = false;
    $('wrDeck').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not open that review.', true);
  }
}

// ---------------------------------------------------------
// Targets
// ---------------------------------------------------------
const METRICS = ['leads', 'logins', 'sanctions', 'pf', 'disbursals'];

async function renderTargets() {
  const host = $('wrTargets');
  const weekEnd = $('wrWeekEnd').value || new Date().toISOString().slice(0, 10);
  const d = new Date(weekEnd + 'T00:00:00');
  const weekStart = new Date(d.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const monthStart = `${weekEnd.slice(0, 7)}-01`;

  const [users, wk, mo] = await Promise.all([
    supabase.from('users').select('id, full_name').eq('is_deleted', false).eq('status', 'active').order('full_name'),
    listTargets('week', weekStart),
    listTargets('month', monthStart),
  ]);
  const existing = new Map([...wk, ...mo].map((t) => [`${t.period_type}|${t.owner_id ?? ''}|${t.metric}`, t.target_value]));
  const opts = ['<option value="">Whole team</option>']
    .concat((users.data ?? []).map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`)).join('');

  host.innerHTML = `
    <p class="wr-none">Targets for week starting <strong>${esc(weekStart)}</strong>
       and month starting <strong>${esc(monthStart)}</strong>.
       Saved targets appear in the Target vs achievement slide.</p>
    <div class="form-grid" style="margin-bottom:12px;">
      <div class="form-field"><label>Scope</label><select id="tgtOwner">${opts}</select></div>
      <div class="form-field"><label>Period</label>
        <select id="tgtPeriod"><option value="week">Week</option><option value="month">Month</option></select></div>
      <div class="form-field"><label>Metric</label>
        <select id="tgtMetric">${METRICS.map((m) => `<option value="${m}">${m}</option>`).join('')}</select></div>
      <div class="form-field"><label>Target</label><input type="number" min="0" id="tgtValue" /></div>
    </div>
    <button class="btn btn-primary" id="btnSaveTarget">Save target</button>
    <div class="wr-tablewrap" style="margin-top:16px;"><table class="wr-table">
      <thead><tr><th>Scope</th><th>Period</th><th>Metric</th><th>Target</th></tr></thead>
      <tbody>${[...wk, ...mo].map((t) => `<tr>
        <td>${esc(t.users?.full_name || 'Whole team')}</td><td>${esc(t.period_type)}</td>
        <td>${esc(t.metric)}</td><td>${num(t.target_value)}</td></tr>`).join('')
        || '<tr><td colspan="4">No targets set.</td></tr>'}</tbody>
    </table></div>`;

  $('btnSaveTarget').addEventListener('click', async () => {
    const value = Number($('tgtValue').value);
    if (!Number.isFinite(value) || value < 0) { toast('Enter a target of zero or more.', true); return; }
    const periodType = $('tgtPeriod').value;
    try {
      await saveTarget({
        periodType,
        periodStart: periodType === 'week' ? weekStart : monthStart,
        ownerId: $('tgtOwner').value || null,
        metric: $('tgtMetric').value,
        targetValue: value,
        userId: currentUser.id,
      });
      toast('Target saved.');
      renderTargets();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not save the target.', true);
    }
  });
  void existing;
}

// ---------------------------------------------------------
const toast = (msg, isError = false) => showToast(msg, isError);

function setTab(name) {
  document.querySelectorAll('.report-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name));
  $('paneGenerate').hidden = name !== 'generate';
  $('paneHistory').hidden = name !== 'history';
  $('paneTargets').hidden = name !== 'targets';
  if (name === 'history') refreshReviewList();
  if (name === 'targets') renderTargets();
}

async function bootstrap() {
  // getCurrentUser throws when there is no session; guardBootstrap catches it
  // and shows the banner, which is how every other page in this app behaves.
  currentUser = await getCurrentUser();

  $('userName').textContent = currentUser.full_name;
  $('userRole').textContent = currentUser.role;
  $('avatar').textContent = (currentUser.full_name || '?').charAt(0).toUpperCase();
  mountTopbar({ app: 'manager-dashboard', user: currentUser });

  // RLS already refuses the write, but saying so up front beats letting
  // someone generate a deck and fail at the save step.
  if (!['Admin', 'Manager'].includes(currentUser.role)) {
    $('paneGenerate').innerHTML =
      '<p class="empty-state">The Weekly Business Review is available to Admins and Managers.</p>';
    document.querySelector('.report-tabs').hidden = true;
    return;
  }

  $('wrWeekEnd').value = new Date().toISOString().slice(0, 10);
  $('btnGenerate').addEventListener('click', generate);
  $('btnPptx').addEventListener('click', exportPptx);
  $('btnPdf').addEventListener('click', exportPdf);
  document.querySelectorAll('.report-tab').forEach((b) =>
    b.addEventListener('click', () => setTab(b.dataset.tab)));

  $('wrHistory').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    const del = e.target.closest('[data-del]');
    if (open) return openStored(open.dataset.open);
    if (del) {
      try { await deleteReview(del.dataset.del); await refreshReviewList(); toast('Review deleted.'); }
      catch (err) { toast(err.message || 'Could not delete.', true); }
    }
  });

  setTab('generate');
}

guardBootstrap(bootstrap, 'Weekly Business Review');
