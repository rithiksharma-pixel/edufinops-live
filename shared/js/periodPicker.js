// =========================================================
// SHARED — the period picker every dashboard uses
//
// Each dashboard card used to own its own date control: 7d/30d/90d pills on
// one, Day/Week/Month on the next, "Apr–Jul" on a third, and nothing at all
// on several. Only one card in the whole product could answer "what did last
// month look like". This is the single control that replaces them: the same
// presets, the same custom range and the same date maths everywhere, so a
// number on one dashboard is for the same window as the number beside it.
//
// The choice is remembered (localStorage), so picking "Last month" on the
// Manager Dashboard is still "Last month" on the Admin Console.
//
// All dates are built from LOCAL date parts, never toISOString(): in IST,
// local midnight on the 1st is the previous day in UTC and every month would
// quietly start a day early.
// =========================================================
import { escapeHtml } from './utils.js';

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const day = (d, shift = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift);
const monthStart = (d, shift = 0) => new Date(d.getFullYear(), d.getMonth() + shift, 1);
const monthEnd = (d, shift = 0) => new Date(d.getFullYear(), d.getMonth() + shift + 1, 0);

/** Weeks run Monday–Sunday, as everywhere else in the app. */
function monday(d) {
  const dow = d.getDay(); // 0 = Sunday
  return day(d, dow === 0 ? -6 : 1 - dow);
}
const quarterStart = (d, shift = 0) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + shift * 3, 1);
/** Indian financial year: 1 April – 31 March. */
const fyStart = (d, shift = 0) => new Date((d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) + shift, 3, 1);

/**
 * `range(today)` returns [from, to] as Dates. `months` marks a calendar-
 * aligned preset and how far back its comparison period sits (`days` does
 * the same for a week); `whole` says the preset is a complete period rather
 * than "so far".
 */
const PRESETS = [
  { id: 'today', label: 'Today', group: 'Days', range: (t) => [t, t] },
  { id: 'yesterday', label: 'Yesterday', group: 'Days', range: (t) => [day(t, -1), day(t, -1)] },
  { id: 'last-7', label: 'Last 7 days', group: 'Days', range: (t) => [day(t, -6), t] },
  { id: 'last-30', label: 'Last 30 days', group: 'Days', range: (t) => [day(t, -29), t] },
  { id: 'last-90', label: 'Last 90 days', group: 'Days', range: (t) => [day(t, -89), t] },
  { id: 'this-week', label: 'This week', group: 'Weeks', days: 7, range: (t) => [monday(t), t] },
  { id: 'last-week', label: 'Last week', group: 'Weeks', range: (t) => [day(monday(t), -7), day(monday(t), -1)] },
  { id: 'this-month', label: 'This month', group: 'Months', months: 1, range: (t) => [monthStart(t), t] },
  { id: 'last-month', label: 'Last month', group: 'Months', months: 1, whole: true, range: (t) => [monthStart(t, -1), monthEnd(t, -1)] },
  { id: 'this-quarter', label: 'This quarter', group: 'Quarters and years', months: 3, range: (t) => [quarterStart(t), t] },
  { id: 'last-quarter', label: 'Last quarter', group: 'Quarters and years', months: 3, whole: true, range: (t) => [quarterStart(t, -1), day(quarterStart(t), -1)] },
  { id: 'this-fy', label: 'This financial year', group: 'Quarters and years', months: 12, range: (t) => [fyStart(t), t] },
  { id: 'last-fy', label: 'Last financial year', group: 'Quarters and years', months: 12, whole: true, range: (t) => [fyStart(t, -1), day(fyStart(t), -1)] },
  { id: 'all', label: 'All time', group: 'Other', range: () => [null, null] },
  { id: 'custom', label: 'Custom range…', group: 'Other' },
];
const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

/** Same day of the month `months` earlier, clamped: 31 March -> 28 February. */
function shiftMonths(d, months) {
  const first = new Date(d.getFullYear(), d.getMonth() - months, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), monthEnd(first).getDate()));
}

/**
 * The period to compare against. Calendar presets compare with the calendar
 * period before — the first nine days of this month against the first nine
 * of last month, and Monday-to-Wednesday against last Monday-to-Wednesday,
 * not against the days that happened to precede them.
 * Everything else compares with the equal-length window immediately before.
 */
function previousRange(preset, from, to) {
  if (!from || !to) return null;
  if (preset?.months) {
    const prevFrom = shiftMonths(from, preset.months);
    const prevTo = preset.whole ? monthEnd(shiftMonths(monthStart(to), preset.months)) : shiftMonths(to, preset.months);
    return { from: isoDate(prevFrom), to: isoDate(prevTo) };
  }
  if (preset?.days) return { from: isoDate(day(from, -preset.days)), to: isoDate(day(to, -preset.days)) };
  const days = Math.round((to - from) / 86400000) + 1;
  return { from: isoDate(day(from, -days)), to: isoDate(day(from, -1)) };
}

const fmt = (d, withYear) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });

/** "1 Sep – 30 Sep 2026", "1 Oct 2026", or "All time". Takes ISO dates. */
export function rangeText(from, to) {
  if (!from && !to) return 'All time';
  if (!from) return `Up to ${fmt(parseIso(to), true)}`;
  if (!to) return `From ${fmt(parseIso(from), true)}`;
  if (from === to) return fmt(parseIso(from), true);
  const a = parseIso(from); const b = parseIso(to);
  return `${fmt(a, a.getFullYear() !== b.getFullYear())} – ${fmt(b, true)}`;
}

/**
 * Resolves a preset id (or a custom from/to) into the value every dashboard
 * consumes:
 *   { id, label, from, to, text, isAll, prev: {from,to}|null, fromTs, toTs }
 * from/to are inclusive ISO dates (null = unbounded) for date columns and
 * RPCs. fromTs/toTs are the same window as instants, for timestamp columns,
 * running from local midnight to the last millisecond of the local day.
 */
export function resolvePeriod(id, custom = {}) {
  const preset = PRESET_BY_ID[id] || PRESET_BY_ID['last-30'];
  let from; let to;
  if (preset.id === 'custom') {
    from = custom.from ? parseIso(custom.from) : null;
    to = custom.to ? parseIso(custom.to) : null;
  } else {
    [from, to] = preset.range(day(new Date()));
  }
  const isoFrom = from ? isoDate(from) : null;
  const isoTo = to ? isoDate(to) : null;
  return {
    id: preset.id,
    label: preset.id === 'custom' ? 'Custom range' : preset.label,
    from: isoFrom,
    to: isoTo,
    text: rangeText(isoFrom, isoTo),
    isAll: !from && !to,
    prev: previousRange(preset, from, to),
    fromTs: from ? from.toISOString() : null,
    toTs: to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).toISOString() : null,
  };
}

/**
 * A test for "does this row fall in the period", for filtering rows already
 * in the browser. Accepts either kind of value a row carries: a plain date
 * ('2026-09-14') is compared as a date, a timestamp as an instant. A row with
 * no value is outside every bounded period.
 */
export function periodTester(period) {
  if (period.isAll) return () => true;
  const fromMs = period.fromTs ? new Date(period.fromTs).getTime() : -Infinity;
  const toMs = period.toTs ? new Date(period.toTs).getTime() : Infinity;
  return (value) => {
    if (!value) return false;
    if (typeof value === 'string' && value.length === 10) {
      return (!period.from || value >= period.from) && (!period.to || value <= period.to);
    }
    const ms = new Date(value).getTime();
    return ms >= fromMs && ms <= toMs;
  };
}

function readStored(storageKey) {
  if (!storageKey) return null;
  try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (e) { return null; }
}
function writeStored(storageKey, value) {
  if (!storageKey) return;
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch (e) { /* private mode: not remembered */ }
}

/**
 * Mounts the picker into `host`.
 *
 * @param {object}   opts
 * @param {Element}  opts.host
 * @param {Function} opts.onChange   called with the new period value
 * @param {string}   [opts.defaultId='last-30']
 * @param {?string}  [opts.storageKey='zt-period']  null = do not remember
 * @param {string[]} [opts.only]     restrict to these preset ids
 * @returns {{ get: () => object, set: (id: string, custom?: object) => void }}
 */
export function mountPeriodPicker({ host, onChange, defaultId = 'last-30', storageKey = 'zt-period', only = null }) {
  const presets = PRESETS.filter((p) => !only || only.includes(p.id));
  const stored = readStored(storageKey);
  const state = {
    id: stored && presets.some((p) => p.id === stored.id) ? stored.id : defaultId,
    custom: { from: stored?.from || '', to: stored?.to || '' },
  };
  // A remembered custom range with a missing end is not a range.
  if (state.id === 'custom' && !(state.custom.from && state.custom.to)) state.id = defaultId;

  const groups = [...new Set(presets.map((p) => p.group))];
  host.classList.add('period-picker');
  host.innerHTML = `
    <i class="fa-regular fa-calendar" aria-hidden="true"></i>
    <select class="period-picker-select" aria-label="Period">
      ${groups.map((g) => `<optgroup label="${escapeHtml(g)}">${presets.filter((p) => p.group === g)
        .map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('')}</optgroup>`).join('')}
    </select>
    <span class="period-picker-custom" hidden>
      <input type="date" data-pp-from aria-label="From date" />
      <span>to</span>
      <input type="date" data-pp-to aria-label="To date" />
    </span>
    <span class="period-picker-text" aria-live="polite"></span>`;

  const select = host.querySelector('select');
  const customEl = host.querySelector('.period-picker-custom');
  const fromEl = host.querySelector('[data-pp-from]');
  const toEl = host.querySelector('[data-pp-to]');
  const textEl = host.querySelector('.period-picker-text');

  const value = () => resolvePeriod(state.id, state.custom);

  function paint(message = '') {
    select.value = state.id;
    const isCustom = state.id === 'custom';
    customEl.hidden = !isCustom;
    fromEl.value = state.custom.from;
    toEl.value = state.custom.to;
    textEl.classList.toggle('is-error', Boolean(message));
    // A custom range already shows its dates in the inputs.
    textEl.textContent = message || (isCustom ? '' : value().text);
  }

  function commit() {
    writeStored(storageKey, { id: state.id, ...state.custom });
    paint();
    onChange?.(value());
  }

  select.addEventListener('change', () => {
    const previous = value();
    state.id = select.value;
    if (state.id !== 'custom') { commit(); return; }
    // Start a custom range from whatever was showing, so it opens on real
    // dates to adjust rather than two empty boxes.
    if (!(state.custom.from && state.custom.to)) {
      state.custom = { from: previous.from || isoDate(day(new Date(), -29)), to: previous.to || isoDate(new Date()) };
    }
    commit();
  });

  function onCustomInput() {
    const from = fromEl.value; const to = toEl.value;
    if (!from || !to) { paint('Pick both dates'); fromEl.value = from; toEl.value = to; return; }
    if (from > to) { paint('"From" is after "To"'); fromEl.value = from; toEl.value = to; return; }
    state.custom = { from, to };
    commit();
  }
  fromEl.addEventListener('change', onCustomInput);
  toEl.addEventListener('change', onCustomInput);

  paint();
  return {
    get: value,
    set(id, custom) {
      state.id = PRESET_BY_ID[id] ? id : defaultId;
      if (custom) state.custom = { from: custom.from || '', to: custom.to || '' };
      commit();
    },
  };
}
