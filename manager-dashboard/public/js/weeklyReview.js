// =========================================================
// Weekly Business Review — page controller
//
// One button: fetch → compute → lay out → store, with a step tracker.
//
// Charts are described once as data (reviewDeck.buildCharts) and rendered
// twice: by Chart.js on screen, and as NATIVE PowerPoint charts in the
// export. The deck used to rasterise Chart.js to PNG and embed the picture,
// which is why the slides looked soft and stretched — a bitmap has a fixed
// aspect and cannot be edited. Native charts stay sharp, stay editable, and
// keep the file small.
// =========================================================
import { supabase } from './config/supabaseClient.js';
import { getCurrentUser } from './services/authService.js';
import {
  fetchReviewData, fetchReviewSeries, saveReview, listReviews, getReview,
  deleteReview, listTargets, saveTarget,
} from './services/weeklyReviewService.js';
import {
  BRAND, FONT, FONT_FALLBACK, num, buildSections, buildCharts,
} from './reviewDeck.js';
import { mountTopbar } from '../../../shared/js/appNav.js';
import { guardDestination, applyNavPermissions } from '../../../shared/js/roleAccess.js';
import { showToast } from '../../../shared/js/toast.js';
import { guardBootstrap } from '../../../shared/js/bootstrapGuard.js';

const STEPS = [
  ['fetch', 'Fetching the latest CRM data'],
  ['series', 'Loading the weekly and monthly run'],
  ['build', 'Laying out the deck'],
  ['render', 'Drawing charts'],
  ['store', 'Saving to Weekly Reviews'],
];

let currentUser = null;
let lastPayload = null;
let lastSections = null;
let lastCharts = null;
const liveCharts = [];   // Chart.js instances, destroyed before each re-render

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (h) => `#${h}`;

// ---------------------------------------------------------
// Progress
// ---------------------------------------------------------
function renderSteps() {
  $('wrSteps').innerHTML = STEPS.map(([k, label]) =>
    `<li class="wr-step" data-step="${k}"><span class="wr-step-dot"></span>${esc(label)}</li>`).join('');
}
const setStep = (k, state) => {
  const el = document.querySelector(`.wr-step[data-step="${k}"]`);
  if (el) el.className = `wr-step ${state}`;
};
const setProgress = (p, label) => {
  $('wrBar').style.width = `${p}%`;
  $('wrProgressLabel').textContent = label;
};
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
    setStep('fetch', 'active'); setProgress(10, 'Fetching the latest CRM data…'); await breathe();
    const data = await fetchReviewData(weekEnd);
    setStep('fetch', 'done');

    setStep('series', 'active'); setProgress(32, 'Loading the run rate…'); await breathe();
    // A missing series must not cost the whole deck — the trend slides are
    // simply omitted if this call fails.
    try {
      data.series = await fetchReviewSeries(weekEnd, 12, 6);
    } catch (seriesErr) {
      console.error(seriesErr);
      data.series = { weeks: [], months: [] };
      showToast('Trend data unavailable; the rest of the deck is unaffected.', true);
    }
    lastPayload = data;
    setStep('series', 'done');

    setStep('build', 'active'); setProgress(55, 'Laying out the deck…'); await breathe();
    lastCharts = buildCharts(data);
    lastSections = buildSections(data, lastCharts);
    setStep('build', 'done');

    setStep('render', 'active'); setProgress(75, 'Drawing charts…'); await breathe();
    renderDeck(lastSections, data);
    setStep('render', 'done');

    setStep('store', 'active'); setProgress(92, 'Saving…'); await breathe();
    try {
      await saveReview({
        weekStart: data.meta.week_start, weekEnd: data.meta.week_end,
        title: `Weekly Business Review — week ending ${data.meta.week_end}`,
        payload: data, userId: currentUser.id,
      });
      setStep('store', 'done');
      await refreshReviewList();
    } catch (storeErr) {
      console.error(storeErr);
      setStep('store', 'failed');
      showToast(`Deck ready, but it could not be saved: ${storeErr.message}`, true);
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
    showToast(err.message || 'Could not generate the review.', true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------
// On-screen deck
// ---------------------------------------------------------
function tableHtml(t) {
  if (!t?.rows?.length) return '';
  return `${t.title ? `<h4 class="wr-subhead">${esc(t.title)}</h4>` : ''}
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
  liveCharts.forEach((c) => c.destroy());
  liveCharts.length = 0;

  $('wrDeck').innerHTML = sections.map((s) => `
    <section class="wr-slide" id="slide-${s.id}">
      <div class="wr-slide-head">
        <div class="wr-slide-headings">
          <span class="wr-eyebrow">${esc(s.eyebrow)}</span>
          <h2>${esc(s.headline)}</h2>
          ${s.caption ? `<p class="wr-caption">${esc(s.caption)}</p>` : ''}
        </div>
        <span class="wr-slide-no">${s.number}</span>
      </div>

      ${s.awaiting ? `<div class="wr-awaiting"><strong>Awaiting input.</strong>
        ${esc(s.awaitingReason || '')} The layout below is ready to fill in.</div>` : ''}

      ${s.stats?.length ? `<div class="wr-stats">${s.stats.map((k) => `
        <div class="wr-stat">
          <span class="wr-stat-value">${esc(k.value)}</span>
          <span class="wr-stat-label">${esc(k.label)}</span>
          ${k.delta ? `<span class="wr-stat-delta ${k.delta.startsWith('+') ? 'up' : (k.delta.startsWith('-') ? 'down' : '')}">${esc(k.delta)}</span>` : ''}
        </div>`).join('')}</div>` : ''}

      ${s.lists ? s.lists.map((l) => `
        <h4 class="wr-subhead tone-${l.tone}">${esc(l.heading)}</h4>
        ${l.items.length
          ? `<ul class="wr-list">${l.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
          : '<p class="wr-none">Nothing flagged.</p>'}`).join('') : ''}

      ${s.chart ? `<div class="wr-chartbox"><canvas data-chart="${s.id}"></canvas></div>` : ''}
      ${tableHtml(s.table)}
      ${tableHtml(s.table2)}
      ${s.notes?.length ? `<ul class="wr-notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </section>`).join('');

  sections.filter((s) => s.chart).forEach((s) => {
    const canvas = document.querySelector(`canvas[data-chart="${s.id}"]`);
    if (canvas) liveCharts.push(new Chart(canvas.getContext('2d'), chartJsConfig(s.chart)));
  });

  $('wrDeckMeta').textContent =
    `Week ${data.meta.week_start} to ${data.meta.week_end} · generated ${new Date(data.meta.generated_at).toLocaleString('en-IN')}`;
}

/**
 * One chart spec, Chart.js flavour. Bars are neutral except the highlighted
 * one; a two-series chart puts the accent on the series that matters (the
 * current period), never on both.
 */
function chartJsConfig(spec) {
  const single = spec.series.length === 1;
  const datasets = spec.series.map((ser, i) => {
    const isLast = i === spec.series.length - 1;
    if (spec.kind === 'line') {
      return {
        label: ser.name, data: ser.values,
        borderColor: isLast ? hex(BRAND.neutral) : hex(BRAND.accent),
        backgroundColor: 'transparent', borderWidth: 2.5,
        pointRadius: 3, pointBackgroundColor: isLast ? hex(BRAND.neutral) : hex(BRAND.accent),
        tension: 0.25,
      };
    }
    const hi = new Set(spec.highlight || []);
    const colors = single
      ? ser.values.map((_, j) => (hi.has(j) ? hex(BRAND.accent) : hex(BRAND.neutral)))
      : (isLast ? hex(BRAND.accent) : hex(BRAND.neutral));
    return { label: ser.name, data: ser.values, backgroundColor: colors, borderWidth: 0 };
  });

  return {
    type: spec.kind === 'line' ? 'line' : 'bar',
    data: { labels: spec.cats, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: !single, labels: { color: hex(BRAND.inkMuted), boxWidth: 12, font: { size: 12 } } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { ticks: { color: hex(BRAND.inkMuted), font: { size: 11 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: hex(BRAND.inkMuted), font: { size: 11 } },
             grid: { color: hex(BRAND.line) }, border: { display: false } },
      },
    },
  };
}

// ---------------------------------------------------------
// PowerPoint — native shapes and native charts
// ---------------------------------------------------------
const W = 13.33, H = 7.5;
const M = 0.62;                 // page margin
const BODY_TOP = 2.05;          // first line under the standard header

function pptxFont(o = {}) {
  return { fontFace: FONT, ...o };
}

/** Eyebrow, headline, caption, section number — the reference deck's header. */
function slideHeader(slide, s) {
  slide.background = { color: BRAND.ground };
  slide.addText(s.eyebrow || '', {
    x: M, y: 0.5, w: W - M * 2 - 1.2, h: 0.28, isTextBox: true, margin: 0,
    ...pptxFont({ fontSize: 12, bold: true, color: BRAND.accent, charSpacing: 2 }),
  });
  slide.addText(s.headline || '', {
    x: M, y: 0.82, w: W - M * 2 - 1.2, h: 0.62, isTextBox: true, margin: 0,
    ...pptxFont({ fontSize: 26, bold: true, color: BRAND.ink }),
  });
  if (s.caption) {
    slide.addText(s.caption, {
      x: M, y: 1.48, w: W - M * 2 - 1.2, h: 0.4, isTextBox: true, margin: 0,
      ...pptxFont({ fontSize: 12.5, color: BRAND.inkMuted }),
    });
  }
  slide.addText(s.number, {
    x: W - M - 1.0, y: 0.46, w: 1.0, h: 0.6, align: 'right', isTextBox: true, margin: 0,
    ...pptxFont({ fontSize: 30, bold: true, color: BRAND.line }),
  });
}

/** Big-number callouts, the reference deck's signature device. */
function addStats(slide, stats, y) {
  const gap = 0.26;
  const cw = (W - M * 2 - gap * (stats.length - 1)) / stats.length;
  stats.forEach((k, i) => {
    const x = M + i * (cw + gap);
    slide.addShape('rect', { x, y, w: cw, h: 1.3, fill: { color: BRAND.paper }, line: { color: BRAND.line, width: 0.75 } });
    slide.addText(String(k.value), {
      x: x + 0.16, y: y + 0.12, w: cw - 0.32, h: 0.62, isTextBox: true, margin: 0,
      ...pptxFont({ fontSize: 34, bold: true, color: BRAND.ink }),
    });
    slide.addText(k.label, {
      x: x + 0.16, y: y + 0.76, w: cw - 0.32, h: 0.32, isTextBox: true, margin: 0,
      ...pptxFont({ fontSize: 10.5, color: BRAND.inkMuted }),
    });
    if (k.delta) {
      slide.addText(k.delta, {
        x: x + 0.16, y: y + 1.02, w: cw - 0.32, h: 0.24, isTextBox: true, margin: 0,
        ...pptxFont({ fontSize: 11, bold: true,
          color: k.delta.startsWith('+') ? BRAND.good : (k.delta.startsWith('-') ? BRAND.bad : BRAND.inkMuted) }),
      });
    }
  });
  return y + 1.55;
}

/** A native chart, styled the reference deck's way. */
function addNativeChart(pptx, slide, spec, y, h) {
  const single = spec.series.length === 1;
  const data = spec.series.map((ser) => ({
    name: ser.name, labels: spec.cats, values: ser.values,
  }));

  // For a single series, chartColors cycles PER POINT — which is how the
  // highlighted bar gets the accent while the rest stay neutral.
  const hi = new Set(spec.highlight || []);
  const chartColors = single
    ? spec.cats.map((_, i) => (hi.has(i) ? BRAND.accent : BRAND.neutral))
    : [BRAND.neutral, BRAND.accent];

  const common = {
    x: M, y, w: W - M * 2, h,
    chartColors,
    showLegend: !single,
    legendPos: 'b',
    legendColor: BRAND.inkMuted,
    legendFontSize: 10,
    catAxisLabelColor: BRAND.inkMuted,
    valAxisLabelColor: BRAND.inkMuted,
    catAxisLabelFontSize: 10,
    valAxisLabelFontSize: 10,
    catAxisLabelFontFace: FONT_FALLBACK,
    valAxisLabelFontFace: FONT_FALLBACK,
    catGridLine: { style: 'none' },
    valGridLine: { color: BRAND.line, size: 0.75 },
    catAxisLineShow: false,
    valAxisLineShow: false,
    dataLabelColor: BRAND.ink,
    dataLabelFontSize: 9,
    dataLabelFontFace: FONT_FALLBACK,
  };

  if (spec.kind === 'line') {
    slide.addChart(pptx.ChartType.line, data, {
      ...common, lineSize: 2.5, lineSmooth: true,
      showValue: false, lineDataSymbolSize: 6,
    });
  } else {
    slide.addChart(pptx.ChartType.bar, data, {
      ...common, barDir: 'col', barGapWidthPct: 55,
      showValue: true, dataLabelPosition: 'outEnd',
    });
  }
}

async function exportPptx() {
  if (!lastSections) return;
  if (typeof PptxGenJS === 'undefined') {
    showToast('The PowerPoint library did not load. Reload and try again.', true);
    return;
  }
  const btn = $('btnPptx');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Building…';

  try {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Zolve Tangent';
    pptx.company = 'Zolve Tangent';
    pptx.title = `Weekly Business Review — ${lastPayload.meta.week_end}`;

    // ---- Cover ----
    const cover = pptx.addSlide();
    cover.background = { color: BRAND.ink };
    cover.addText('WEEKLY BUSINESS REVIEW', {
      x: M, y: 2.55, w: W - M * 2, h: 0.34, isTextBox: true, margin: 0,
      ...pptxFont({ fontSize: 13, bold: true, color: BRAND.accent, charSpacing: 3 }),
    });
    cover.addText(`Week ending ${lastPayload.meta.week_end}`, {
      x: M, y: 2.95, w: W - M * 2, h: 1.0, isTextBox: true, margin: 0,
      ...pptxFont({ fontSize: 42, bold: true, color: BRAND.paper }),
    });
    cover.addText('Zolve Tangent', {
      x: M, y: H - 1.05, w: 6, h: 0.36, isTextBox: true, margin: 0,
      ...pptxFont({ fontSize: 12.5, color: BRAND.neutral }),
    });

    for (const s of lastSections) addSectionSlides(pptx, s);

    await pptx.writeFile({ fileName: `Weekly-Business-Review-${lastPayload.meta.week_end}.pptx` });
    showToast('PowerPoint downloaded.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not build the PowerPoint.', true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function addSectionSlides(pptx, s) {
  const first = pptx.addSlide();
  slideHeader(first, s);
  let y = BODY_TOP;

  if (s.awaiting) {
    first.addShape('rect', { x: M, y, w: W - M * 2, h: 0.8, fill: { color: BRAND.accentSoft } });
    first.addText(`Awaiting input — ${s.awaitingReason || ''}`, {
      x: M + 0.18, y: y + 0.12, w: W - M * 2 - 0.36, h: 0.58, isTextBox: true, margin: 0, valign: 'top',
      ...pptxFont({ fontSize: 11, color: BRAND.ink }),
    });
    y += 1.0;
  }

  if (s.stats?.length) y = addStats(first, s.stats, y);

  if (s.lists) {
    for (const l of s.lists) {
      if (y > H - 1.4) break;
      const tone = l.tone === 'good' ? BRAND.good : (l.tone === 'bad' ? BRAND.bad : BRAND.accent);
      first.addText(l.heading, {
        x: M, y, w: W - M * 2, h: 0.26, isTextBox: true, margin: 0,
        ...pptxFont({ fontSize: 12, bold: true, color: tone }),
      });
      y += 0.3;
      const items = l.items.length ? l.items : ['Nothing flagged.'];
      const h = Math.min(items.length * 0.25 + 0.08, H - y - 0.4);
      first.addText(items.map((x, i) => ({
        text: x, options: { bullet: true, breakLine: i < items.length - 1 },
      })), {
        x: M + 0.14, y, w: W - M * 2 - 0.28, h, isTextBox: true, margin: 0, valign: 'top',
        ...pptxFont({ fontSize: 10.5, color: BRAND.ink, paraSpaceAfter: 3 }),
      });
      y += h + 0.1;
    }
  }

  if (s.notes?.length && y < H - 0.9) {
    first.addText(s.notes.map((n, i) => ({
      text: n, options: { bullet: true, breakLine: i < s.notes.length - 1 },
    })), {
      x: M, y, w: W - M * 2, h: Math.min(s.notes.length * 0.24 + 0.08, H - y - 0.3),
      isTextBox: true, margin: 0, valign: 'top',
      ...pptxFont({ fontSize: 9.5, color: BRAND.inkMuted }),
    });
  }

  // Charts get a slide of their own, full width, at a comfortable height.
  if (s.chart) {
    const slide = pptx.addSlide();
    slideHeader(slide, { ...s, caption: s.chart.title });
    addNativeChart(pptx, slide, s.chart, BODY_TOP, H - BODY_TOP - 0.5);
  }

  // Tables likewise, chunked so rows stay legible rather than shrinking.
  for (const tbl of [s.table, s.table2]) {
    if (!tbl?.rows?.length) continue;
    const CHUNK = 14;
    for (let i = 0; i < tbl.rows.length; i += CHUNK) {
      const slide = pptx.addSlide();
      const part = tbl.rows.length > CHUNK ? ` (${Math.floor(i / CHUNK) + 1})` : '';
      slideHeader(slide, { ...s, caption: (tbl.title || s.caption || '') + part });
      const head = tbl.head.map((h) => ({
        text: h, options: { bold: true, color: BRAND.paper, fill: { color: BRAND.ink } },
      }));
      const body = tbl.rows.slice(i, i + CHUNK).map((r) => r.map((c) => {
        const v = String(c ?? '');
        return { text: v === '' ? '' : v, options: {
          color: v.startsWith('+') ? BRAND.good
            : (v.startsWith('-') && v.endsWith('%') ? BRAND.bad : BRAND.ink),
          fill: { color: BRAND.paper },
        } };
      }));
      slide.addTable([head, ...body], {
        x: M, y: BODY_TOP, w: W - M * 2, valign: 'middle',
        fontSize: 10, fontFace: FONT_FALLBACK, color: BRAND.ink,
        border: { type: 'solid', color: BRAND.line, pt: 0.5 },
        autoPage: false,
      });
    }
  }
}

// ---------------------------------------------------------
// PDF via the browser's own print pipeline
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
  setTimeout(restore, 60000);
}

// ---------------------------------------------------------
// Stored reviews
// ---------------------------------------------------------
async function refreshReviewList() {
  const host = $('wrHistory');
  try {
    const rows = await listReviews();
    host.innerHTML = rows.length ? rows.map((r) => `
      <div class="wr-hist-row">
        <div><strong>${esc(r.title)}</strong>
          <span class="wr-hist-meta">${esc(r.week_start)} → ${esc(r.week_end)}
            · ${new Date(r.generated_at).toLocaleString('en-IN')}
            ${r.users?.full_name ? `· ${esc(r.users.full_name)}` : ''}</span></div>
        <div class="wr-hist-actions">
          <button class="btn btn-ghost" data-open="${r.id}">Open</button>
          <button class="btn btn-ghost" data-del="${r.id}">Delete</button>
        </div>
      </div>`).join('') : '<p class="wr-none">No reviews generated yet.</p>';
  } catch (err) {
    console.error(err);
    host.innerHTML = '<p class="wr-none">Could not load saved reviews.</p>';
  }
}

async function openStored(id) {
  try {
    const row = await getReview(id);
    lastPayload = row.payload;
    lastCharts = buildCharts(row.payload);
    lastSections = buildSections(row.payload, lastCharts);
    renderDeck(lastSections, row.payload);
    $('wrExports').hidden = false;
    $('wrDeck').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not open that review.', true);
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
  const opts = ['<option value="">Whole team</option>']
    .concat((users.data ?? []).map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`)).join('');

  host.innerHTML = `
    <p class="wr-none">Targets for the week starting <strong>${esc(weekStart)}</strong>
       and the month starting <strong>${esc(monthStart)}</strong>.</p>
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
    if (!Number.isFinite(value) || value < 0) { showToast('Enter a target of zero or more.', true); return; }
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
      showToast('Target saved.');
      renderTargets();
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not save the target.', true);
    }
  });
}

// ---------------------------------------------------------
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
  currentUser = await getCurrentUser();

  $('userName').textContent = currentUser.full_name;
  $('userRole').textContent = currentUser.role;
  $('avatar').textContent = (currentUser.full_name || '?').charAt(0).toUpperCase();
  if (!guardDestination(currentUser, 'weekly-review')) return;
  applyNavPermissions(currentUser.role);
  mountTopbar({ app: 'manager-dashboard', user: currentUser });

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
      try { await deleteReview(del.dataset.del); await refreshReviewList(); showToast('Review deleted.'); }
      catch (err) { showToast(err.message || 'Could not delete.', true); }
    }
  });

  setTab('generate');
}

guardBootstrap(bootstrap, 'Weekly Business Review');
