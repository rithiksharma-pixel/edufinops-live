// =========================================================
// SHARED — insights: what the numbers on a page say, in one sentence each
//
// Every insight is computed from the same rows the page's tables show, at
// render time — never typed in — so it moves when the data moves and can
// never contradict the table under it. Pages pick which generators apply;
// this file only knows arithmetic and wording.
//
// Tones: 'warn' for a risk (concentration, a stall, a data gap), 'good' for
// something working, '' for plain context. At most ~4 per page: an insight
// strip that says everything says nothing.
// =========================================================
import { escapeHtml } from './utils.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

/**
 * Pareto: the smallest share of contributors that together make `target` of
 * the total. Returns null when there is too little to say it about.
 * @returns {{ count, total, share, covered, top: object[] } | null}
 */
export function concentration(rows, value, target = 0.8) {
  const live = rows.filter((r) => Number(value(r)) > 0).sort((a, b) => value(b) - value(a));
  const total = live.reduce((s, r) => s + Number(value(r)), 0);
  if (live.length < 3 || !total) return null;
  let run = 0; let count = 0;
  for (const r of live) { run += Number(value(r)); count += 1; if (run / total >= target) break; }
  return { count, total, share: count / live.length, covered: run / total, top: live.slice(0, count), contributors: live.length };
}

/** The share the top N contributors hold. */
export function topShare(rows, value, n = 3) {
  const live = rows.filter((r) => Number(value(r)) > 0).sort((a, b) => value(b) - value(a));
  const total = live.reduce((s, r) => s + Number(value(r)), 0);
  if (live.length <= n || !total) return null;
  const held = live.slice(0, n).reduce((s, r) => s + Number(value(r)), 0);
  return { share: held / total, top: live.slice(0, n), total, contributors: live.length };
}

/**
 * Best and worst converters among contributors big enough to judge, measured
 * against the group's own overall rate.
 */
export function outliers(rows, { num, den, label, minDen = 30 }) {
  const eligible = rows.filter((r) => Number(den(r)) >= minDen);
  const tn = rows.reduce((s, r) => s + Number(num(r) || 0), 0);
  const td = rows.reduce((s, r) => s + Number(den(r) || 0), 0);
  if (eligible.length < 3 || !td) return null;
  const rate = (r) => Number(num(r)) / Number(den(r));
  const sorted = [...eligible].sort((a, b) => rate(b) - rate(a));
  return { avg: tn / td, best: sorted[0], worst: sorted[sorted.length - 1], rate, label, eligible: eligible.length };
}

// ---------- Sentence builders (return an insight or null) ----------

/** "10% of partners (82) bring 80% of logins." */
export function paretoInsight(rows, { value, noun, plural, metric, target = 0.8 }) {
  const c = concentration(rows, value, target);
  if (!c) return null;
  const tone = c.share <= 0.2 ? 'warn' : '';
  return {
    tone,
    headline: `${pct(c.share)} of ${plural} bring ${pct(c.covered)} of ${metric}`,
    detail: `${fmt(c.count)} of ${fmt(c.contributors)} ${plural} with any ${metric}. ${c.share <= 0.2 ? `Losing one of the top ${c.count === 1 ? noun : plural} would be felt.` : 'The business is spread fairly widely.'}`,
  };
}

/** "3 BDs carry 78% of logins: A, B, C." */
export function topNInsight(rows, { value, name, n = 3, plural, metric }) {
  const t = topShare(rows, value, n);
  if (!t) return null;
  return {
    tone: t.share >= 0.6 ? 'warn' : '',
    headline: `${n} ${plural} carry ${pct(t.share)} of ${metric}`,
    detail: `${t.top.map((r) => name(r)).join(', ')}, out of ${fmt(t.contributors)}.`,
  };
}

/** "Anmol converts 98% of leads to login, against 56% overall." */
export function outlierInsight(rows, opts) {
  const o = outliers(rows, opts);
  if (!o) return null;
  const { best, worst, rate, avg } = o;
  return {
    tone: '',
    headline: `${opts.label(best)} converts ${pct(rate(best))} ${opts.what}`,
    detail: `Against ${pct(avg)} overall. Lowest of those with ${opts.minDen || 30}+ ${opts.denNoun}: ${opts.label(worst)} at ${pct(rate(worst))}.`,
  };
}

/** A single share worth calling out: a data gap, or a dominant source. */
export function shareInsight({ part, whole, tone = 'warn', headline, detail }) {
  if (!whole || !part) return null;
  return { tone, headline: headline(pct(part / whole)), detail: detail ? detail(pct(part / whole)) : '' };
}

/** Renders up to `max` insights into `host`. Nulls are skipped, so pages can
 *  list every generator and let the data decide which ones have something
 *  to say. */
export function renderInsights(host, insights, { max = 4, title = 'What this shows' } = {}) {
  if (!host) return;
  const list = insights.filter(Boolean).slice(0, max);
  if (!list.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = `
    <div class="insights-head">${escapeHtml(title)}</div>
    <div class="insights-grid">${list.map((i) => `
      <div class="insight ${i.tone || ''}">
        <div class="insight-h">${escapeHtml(i.headline)}</div>
        ${i.detail ? `<div class="insight-d">${escapeHtml(i.detail)}</div>` : ''}
      </div>`).join('')}</div>`;
}

/**
 * The step where the funnel loses the most, as a share of those who reached
 * the step before. `funnel` is [{ name, count }] in stage order.
 */
export function funnelDropInsight(funnel, { noun = 'leads' } = {}) {
  const steps = [];
  for (let i = 1; i < funnel.length; i += 1) {
    const prev = funnel[i - 1].count; const cur = funnel[i].count;
    if (prev >= 20) steps.push({ from: funnel[i - 1].name, to: funnel[i].name, lost: prev - cur, rate: cur / prev });
  }
  if (!steps.length) return null;
  const worst = steps.sort((a, b) => a.rate - b.rate)[0];
  return {
    tone: worst.rate < 0.5 ? 'warn' : '',
    headline: `The biggest drop is ${worst.from} → ${worst.to}`,
    detail: `Only ${pct(worst.rate)} of ${noun} that reach ${worst.from} get to ${worst.to}: ${fmt(worst.lost)} stop there.`,
  };
}
