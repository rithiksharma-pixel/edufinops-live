// =========================================================
// Weekly Business Review — deck model
//
// Design follows the MRM reference deck: warm off-white ground, near-black
// ink, one red accent used sparingly, and charts where the bars are neutral
// EXCEPT the one that carries the point. No rainbow palettes, no legends on
// single-series charts, data labels on.
//
// Each section is described once, declaratively, and rendered twice — as
// HTML on screen and as native PowerPoint shapes and charts. Charts are
// NATIVE in the pptx (addChart), not screenshots: they stay sharp at any
// zoom, are editable, and keep the file small.
//
// Headlines are interpretive, not generic. "Logins fell 30% while intake
// rose 24%" tells a reader what happened; "Weekly Performance" makes them
// work it out from the table. That single difference is most of what
// separates a board deck from a data dump.
// =========================================================

// Lifted from the reference deck's own theme, not invented.
export const BRAND = {
  ink: '1B1B1B',
  inkMuted: '5B5B5B',
  paper: 'FFFFFF',
  ground: 'F7F5F4',   // warm off-white — the slide ground
  line: 'E7E3E0',
  neutral: 'B9B4B0',  // default bar colour
  accent: 'E40018',   // the highlight; used on at most one thing per chart
  accentSoft: 'FDE9E6',
  coral: 'FF8A70',
  good: '2E7D32',
  bad: 'C62828',
};

// Figtree is the reference deck's face; Arial is the metric-compatible
// fallback so a machine without it still lays out correctly.
export const FONT = 'Figtree';
export const FONT_FALLBACK = 'Arial';

const METRIC_LABELS = {
  leads: 'Leads', logins: 'Logins', sanctions: 'Sanctions',
  pf: 'PF Paid', disbursals: 'Disbursals', disbursed_value: 'Disbursed value',
};

// ---------------------------------------------------------
// Numbers
// ---------------------------------------------------------
export const num = (n) => Number(n ?? 0).toLocaleString('en-IN');
export const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Signed growth. Null when the base is zero — "up from nothing" is not a %. */
export function growth(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}
export function growthText(g) {
  return g === null ? 'n/a' : `${g > 0 ? '+' : ''}${g}%`;
}
/** Multiplier, the way the reference deck states growth: "2.9x". */
export function multiple(now, before) {
  if (!before) return null;
  return Math.round((now / before) * 10) / 10;
}

const fmtDate = (d) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Elapsed days in the current month, and the projected full-month figure. */
function monthPace(d, key) {
  const start = new Date(d.meta.month_start + 'T00:00:00');
  const end = new Date(d.meta.month_end + 'T00:00:00');
  const elapsed = Math.round((end - start) / 86400000) + 1;
  const prevStart = new Date(d.meta.prev_month_start + 'T00:00:00');
  const daysInPrev = new Date(prevStart.getFullYear(), prevStart.getMonth() + 1, 0).getDate();
  const projected = elapsed ? Math.round((d.periods.current_month[key] / elapsed) * daysInPrev) : 0;
  return { elapsed, projected, daysInPrev };
}

// ---------------------------------------------------------
// Commentary — rules over the numbers, not a language model. Auditable,
// offline, and incapable of inventing a figure.
// ---------------------------------------------------------
export function buildInsights(d) {
  const out = [];
  const cw = d.periods.current_week, pw = d.periods.previous_week;
  const cm = d.periods.current_month, pm = d.periods.previous_month;
  const f = d.funnel;

  const gLogins = growth(cw.logins, pw.logins);
  const gSanc = growth(cw.sanctions, pw.sanctions);
  const gPf = growth(cw.pf, pw.pf);
  const gLeads = growth(cw.leads, pw.leads);

  if (gLogins !== null) {
    out.push({ tone: gLogins >= 0 ? 'good' : 'bad',
      text: `Logins ${gLogins >= 0 ? 'rose' : 'fell'} ${Math.abs(gLogins)}% week on week — ${num(cw.logins)} against ${num(pw.logins)}.` });
  }
  if (gSanc !== null) {
    out.push({ tone: gSanc >= 0 ? 'good' : 'bad',
      text: `Sanctions ${gSanc >= 0 ? 'rose' : 'fell'} ${Math.abs(gSanc)}% — ${num(cw.sanctions)} against ${num(pw.sanctions)}.` });
  }
  if (gPf !== null) {
    out.push({ tone: gPf >= 0 ? 'good' : 'warn',
      text: `PF paid ${gPf >= 0 ? 'up' : 'down'} ${Math.abs(gPf)}% (${num(cw.pf)} vs ${num(pw.pf)}).` });
  }
  if (gLeads !== null && gLogins !== null && gLeads > 5 && gLogins < -5) {
    out.push({ tone: 'bad',
      text: `Intake grew ${gLeads}% while logins fell ${Math.abs(gLogins)}%. More is arriving and less is converting, so the top-line rise is not reaching the funnel.` });
  }

  const pace = monthPace(d, 'logins');
  const pg = growth(pace.projected, pm.logins);
  if (pg !== null) {
    out.push({ tone: pg >= 0 ? 'good' : 'warn',
      text: `${num(cm.logins)} logins in ${pace.elapsed} days. At this rate the month lands near ${num(pace.projected)} against last month's ${num(pm.logins)} (${growthText(pg)}).` });
  }

  const months = d.series?.months ?? [];
  if (months.length >= 3) {
    const full = months.slice(0, -1);           // drop the part-month
    const first = full[0], last = full[full.length - 1];
    const m = multiple(last.logins, first.logins);
    if (m && m !== 1) {
      out.push({ tone: m >= 1 ? 'good' : 'warn',
        text: `Logins have gone ${m}x since ${first.label} — ${num(first.logins)} to ${num(last.logins)} a month.` });
    }
  }

  const touch = d.touchbase || [];
  const touchTotal = touch.reduce((s, b) => s + Number(b.leads), 0);
  const stale = touch.filter((b) => b.bucket === '31-60 days' || b.bucket === '60+ days')
    .reduce((s, b) => s + Number(b.leads), 0);
  if (stale > 0) {
    out.push({ tone: stale / touchTotal > 0.15 ? 'bad' : 'warn',
      text: `${num(stale)} open leads (${pct(stale, touchTotal)}% of the live book) untouched for more than 30 days.` });
  }

  if (f.login && f.sanction) {
    const conv = pct(f.sanction, f.login);
    out.push({ tone: conv < 40 ? 'warn' : 'good',
      text: `Login to sanction converts at ${conv}%. ${num(f.login - f.sanction)} logged-in leads have not reached sanction.` });
  }
  if (f.login_undated) {
    out.push({ tone: 'warn',
      text: `${num(f.login_undated)} leads sit at Login or beyond with no login date, so they fall out of every weekly figure.` });
  }
  if (d.tat?.create_to_login) {
    out.push({ tone: d.tat.create_to_login > 30 ? 'warn' : 'good',
      text: `Lead created to login averages ${d.tat.create_to_login} days.` });
  }

  const bd = (d.bd || []).filter((b) => b.bd !== '(no BD)');
  const bdTotal = bd.reduce((s, b) => s + Number(b.logins_all), 0);
  if (bd.length && bdTotal) {
    const top = bd.slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all))[0];
    const share = pct(Number(top.logins_all), bdTotal);
    if (share > 25) {
      out.push({ tone: 'warn',
        text: `${top.bd} carries ${share}% of all BD logins — concentration risk in one relationship.` });
    }
  }
  const noBd = (d.bd || []).find((b) => b.bd === '(no BD)');
  if (noBd && Number(noBd.logins_all) > 0) {
    out.push({ tone: 'warn',
      text: `${num(noBd.logins_all)} logins are credited to nobody — the leads behind them carry no BD name.` });
  }

  const dq = d.data_quality || {};
  if (dq.users_with_team < dq.users_total) {
    out.push({ tone: 'warn',
      text: `${dq.users_with_team} of ${dq.users_total} active users have a team, so any Bangalore/Hyderabad split is unreliable.` });
  }
  if (!Number(dq.disbursed_value_recorded)) {
    out.push({ tone: 'bad',
      text: `No disbursed amounts are recorded, so disbursed value reads zero. Volume is real; the rupee figures are not captured.` });
  }
  return out;
}

export function categorise(insights) {
  return {
    wins: insights.filter((i) => i.tone === 'good'),
    risks: insights.filter((i) => i.tone === 'bad'),
    watch: insights.filter((i) => i.tone === 'warn'),
  };
}

// ---------------------------------------------------------
// Chart specs — one description, rendered natively in the pptx and by
// Chart.js on screen, so the two can never diverge.
//
// `highlight` is an explicit ARRAY of bar indices that carry the point;
// every other bar stays neutral. It was briefly a single index meaning
// "from here on", which silently painted the whole TAT chart red when the
// bar worth marking was the first one.
// ---------------------------------------------------------
function bar(title, cats, values, { highlight = null, seriesName = 'Value' } = {}) {
  return { kind: 'bar', title, cats, series: [{ name: seriesName, values }], highlight };
}
function grouped(title, cats, series) {
  return { kind: 'bar', title, cats, series, highlight: null };
}
function line(title, cats, series) {
  return { kind: 'line', title, cats, series, highlight: null };
}

export function buildCharts(d) {
  const cw = d.periods.current_week, pw = d.periods.previous_week;
  const f = d.funnel;
  const weeks = d.series?.weeks ?? [];
  const months = d.series?.months ?? [];

  const owners = (d.owners || [])
    .filter((o) => o.owner !== 'Unassigned')
    .slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all)).slice(0, 8);
  const bd = (d.bd || [])
    .filter((b) => b.bd !== '(no BD)')
    .slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all)).slice(0, 8);

  const TOUCH_ORDER = ['0-7 days', '8-14 days', '15-30 days', '31-60 days', '60+ days'];
  const touch = TOUCH_ORDER
    .map((b) => (d.touchbase || []).find((t) => t.bucket === b))
    .filter(Boolean);
  // The stale buckets are the point of this chart, so they carry the accent.
  const staleIdx = touch
    .map((t, i) => (t.bucket === '31-60 days' || t.bucket === '60+ days' ? i : -1))
    .filter((i) => i >= 0);

  return {
    // Trailing weeks — the trend the deck previously could not draw.
    weekTrend: line('Logins by week', weeks.map((w) => w.label), [
      { name: 'Logins', values: weeks.map((w) => Number(w.logins)) },
      { name: 'Sanctions', values: weeks.map((w) => Number(w.sanctions)) },
    ]),
    monthTrend: bar('Logins by month', months.map((m) => m.label),
      months.map((m) => Number(m.logins)),
      // Only the part-month is marked, so nobody reads it as a full month.
      { highlight: [months.length - 1], seriesName: 'Logins' }),

    wow: grouped(`Week on week — ${fmtDate(d.meta.week_start)} vs ${fmtDate(d.meta.prev_week_start)}`,
      ['Logins', 'Sanctions', 'PF paid'], [
        { name: 'Previous week', values: [pw.logins, pw.sanctions, pw.pf] },
        { name: 'This week', values: [cw.logins, cw.sanctions, cw.pf] },
      ]),

    funnel: bar('Leads reaching each stage',
      ['Leads', 'App Start', 'Bank Prospect', 'Login', 'Sanction', 'PF Paid', 'Disbursed'],
      [f.total_leads, f.app_start, f.bank_prospect, f.login, f.sanction, f.pf, f.disbursed],
      { seriesName: 'Leads' }),

    owners: grouped('Top owners by logins', owners.map((o) => o.owner), [
      { name: 'Logins', values: owners.map((o) => Number(o.logins_all)) },
      { name: 'PF paid', values: owners.map((o) => Number(o.pf_all)) },
    ]),

    bd: grouped('Top BD by logins', bd.map((b) => b.bd), [
      { name: 'Logins', values: bd.map((b) => Number(b.logins_all)) },
      { name: 'PF paid', values: bd.map((b) => Number(b.pf_all)) },
    ]),

    touch: bar('Open leads by time since last contact',
      touch.map((t) => t.bucket), touch.map((t) => Number(t.leads)),
      { highlight: staleIdx.length ? staleIdx : null, seriesName: 'Open leads' }),

    tat: bar('Average days between milestones',
      ['Created→Login', 'Login→Sanction', 'Sanction→PF', 'PF→Disbursal'],
      [d.tat?.create_to_login ?? 0, d.tat?.login_to_sanction ?? 0,
       d.tat?.sanction_to_pf ?? 0, d.tat?.pf_to_disbursal ?? 0],
      // Created-to-login is the slow step and the only one worth marking.
      { highlight: [0], seriesName: 'Days' }),
  };
}

// ---------------------------------------------------------
// Sections
// ---------------------------------------------------------
export function buildSections(d, charts) {
  const cw = d.periods.current_week, pw = d.periods.previous_week;
  const cm = d.periods.current_month, pm = d.periods.previous_month;
  const f = d.funnel;
  const insights = buildInsights(d);
  const { wins, risks, watch } = categorise(insights);

  const gLogins = growth(cw.logins, pw.logins);
  const gLeads = growth(cw.leads, pw.leads);
  const pace = monthPace(d, 'logins');

  const owners = (d.owners || []).filter((o) => o.owner !== 'Unassigned')
    .slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all));
  const ownerLoginTotal = owners.reduce((s, o) => s + Number(o.logins_all), 0);
  const bd = (d.bd || []).slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all));
  const bdLoginTotal = bd.reduce((s, b) => s + Number(b.logins_all), 0);

  const months = (d.series?.months ?? []);
  const fullMonths = months.slice(0, -1);
  const trendMultiple = fullMonths.length >= 2
    ? multiple(fullMonths[fullMonths.length - 1].logins, fullMonths[0].logins) : null;

  const stagePairs = [
    ['Leads → App Start', f.total_leads, f.app_start],
    ['App Start → Bank Prospect', f.app_start, f.bank_prospect],
    ['Bank Prospect → Login', f.bank_prospect, f.login],
    ['Login → Sanction', f.login, f.sanction],
    ['Sanction → PF Paid', f.sanction, f.pf],
    ['PF Paid → Disbursed', f.pf, f.disbursed],
  ];

  const touchTotal = (d.touchbase || []).reduce((s, b) => s + Number(b.leads), 0);
  const stale = (d.touchbase || [])
    .filter((b) => b.bucket === '31-60 days' || b.bucket === '60+ days')
    .reduce((s, b) => s + Number(b.leads), 0);

  // Headline for the executive slide, chosen by what actually happened.
  const execHeadline = (() => {
    if (gLeads !== null && gLogins !== null && gLeads > 5 && gLogins < -5) {
      return `Intake up ${gLeads}%, logins down ${Math.abs(gLogins)}%`;
    }
    if (gLogins !== null && gLogins >= 10) return `Logins up ${gLogins}% on the week`;
    if (gLogins !== null && gLogins <= -10) return `Logins down ${Math.abs(gLogins)}% on the week`;
    return `${num(cw.logins)} logins, ${num(cw.pf)} PF paid`;
  })();

  const S = [];
  const push = (s) => { S.push({ ...s, number: String(S.length + 1).padStart(2, '0') }); };

  push({
    id: 'exec', eyebrow: 'EXECUTIVE SUMMARY', headline: execHeadline,
    caption: `Week of ${fmtDate(d.meta.week_start)} to ${fmtDate(d.meta.week_end)}, against the week before.`,
    stats: [
      { value: num(cw.logins), label: 'Logins this week', delta: growthText(gLogins) },
      { value: num(cw.sanctions), label: 'Sanctions', delta: growthText(growth(cw.sanctions, pw.sanctions)) },
      { value: num(cw.pf), label: 'PF paid', delta: growthText(growth(cw.pf, pw.pf)) },
      { value: num(cw.leads), label: 'Leads in', delta: growthText(gLeads) },
    ],
    lists: [
      { heading: 'Working', tone: 'good', items: wins.map((i) => i.text) },
      { heading: 'Needs attention', tone: 'bad', items: risks.map((i) => i.text) },
      { heading: 'Watch', tone: 'warn', items: watch.map((i) => i.text) },
    ],
  });

  if (months.length >= 3) {
    push({
      id: 'trend', eyebrow: 'TREND',
      headline: trendMultiple && trendMultiple > 1
        ? `Logins ${trendMultiple}x since ${fullMonths[0].label}`
        : 'Monthly login run rate',
      caption: `Monthly logins, ${months[0].label} to ${months[months.length - 1].label}. The current month is partial.`,
      chart: charts.monthTrend,
      stats: [
        trendMultiple ? { value: `${trendMultiple}x`, label: `Logins, ${fullMonths[0].label} → ${fullMonths[fullMonths.length - 1].label}` } : null,
        { value: num(pace.projected), label: `${d.meta.month_start.slice(0, 7)} projected at current pace` },
        { value: num(pm.logins), label: 'Last full month' },
      ].filter(Boolean),
      table: {
        head: ['Month', 'Leads', 'Logins', 'Sanctions', 'PF', 'Lead→Login %'],
        rows: months.map((m) => [m.label, num(m.leads), num(m.logins), num(m.sanctions), num(m.pf),
          `${pct(Number(m.logins), Number(m.leads))}%`]),
      },
    });

    push({
      id: 'weeks', eyebrow: 'WEEKLY RUN RATE', headline: 'Logins and sanctions by week',
      caption: 'Trailing weeks. Sanctions track logins with roughly a ten-day lag.',
      chart: charts.weekTrend,
      table: {
        head: ['Week beginning', 'Leads', 'Logins', 'Sanctions', 'PF'],
        rows: (d.series?.weeks ?? []).map((w) => [w.label, num(w.leads), num(w.logins), num(w.sanctions), num(w.pf)]),
      },
    });
  }

  push({
    id: 'overall', eyebrow: 'THE NUMBERS', headline: 'Week and month against their prior period',
    caption: 'Counted on the date each milestone actually happened, not on current stage.',
    chart: charts.wow,
    table: {
      head: ['Metric', 'This week', 'Last week', 'WoW', 'Month to date', 'Last month', 'MoM'],
      rows: ['logins', 'sanctions', 'pf', 'disbursals', 'leads'].map((k) => [
        METRIC_LABELS[k], num(cw[k]), num(pw[k]), growthText(growth(cw[k], pw[k])),
        num(cm[k]), num(pm[k]), growthText(growth(cm[k], pm[k])),
      ]),
    },
    notes: [
      `Pre-login book: ${num(f.total_leads - f.login)} leads have not yet logged in.`,
      `Post-login book: ${num(f.login)} at Login or beyond.`,
      Number(d.data_quality?.disbursed_value_recorded)
        ? `Disbursed value recorded: ${num(d.data_quality.disbursed_value_recorded)}.`
        : 'Disbursed value is not captured in the CRM, so revenue and invoicing cannot be derived from it.',
    ],
  });

  push({
    id: 'funnel', eyebrow: 'FUNNEL', headline: (() => {
      const worst = stagePairs.slice(1).reduce((a, b) =>
        pct(b[2], b[1]) < pct(a[2], a[1]) ? b : a);
      return `${worst[0]} is the tightest step, at ${pct(worst[2], worst[1])}%`;
    })(),
    caption: 'Every lead that ever reached each stage, with the drop between.',
    chart: charts.funnel,
    table: {
      head: ['Transition', 'From', 'To', 'Conversion', 'Drop-off'],
      rows: stagePairs.map(([label, from, to]) => [
        label, num(from), num(to), `${pct(to, from)}%`, num(Math.max(0, from - to))]),
    },
    notes: [
      `${num(f.login_undated)} leads are at Login or beyond with no login date, and ${num(f.pf_undated)} at PF with no PF date.`,
      `Lost: ${num(f.lost)}.`,
    ],
  });

  push({
    id: 'tat', eyebrow: 'SPEED', headline: `Lead to login takes ${d.tat?.create_to_login ?? '–'} days`,
    caption: 'Average days between milestones, measured only where both dates exist.',
    chart: charts.tat,
    stats: [
      { value: `${d.tat?.create_to_login ?? '–'}d`, label: 'Created → Login' },
      { value: `${d.tat?.login_to_sanction ?? '–'}d`, label: 'Login → Sanction' },
      { value: `${d.tat?.sanction_to_pf ?? '–'}d`, label: 'Sanction → PF' },
      { value: `${d.tat?.pf_to_disbursal ?? '–'}d`, label: 'PF → Disbursal' },
    ],
  });

  push({
    id: 'owners', eyebrow: 'OWNERS', headline: owners.length
      ? `${owners[0].owner} leads on ${num(owners[0].logins_all)} logins`
      : 'Owner performance',
    caption: 'Ranked by logins, not lead count — volume handed out is not volume converted.',
    chart: charts.owners,
    table: {
      head: ['Owner', 'Logins', 'PF', 'Login→PF', 'Share of logins', 'Leads'],
      rows: owners.slice(0, 12).map((o) => [
        o.owner, num(o.logins_all), num(o.pf_all),
        `${pct(Number(o.pf_all), Number(o.logins_all))}%`,
        `${pct(Number(o.logins_all), ownerLoginTotal)}%`, num(o.leads_all)]),
    },
  });

  push({
    id: 'owner-periods', eyebrow: 'OWNERS', headline: 'Week and month by owner',
    caption: 'Movement per owner, on logins and PF.',
    table: {
      head: ['Owner', 'Logins wk', 'Prev wk', 'WoW', 'Logins mo', 'Prev mo', 'MoM', 'PF wk', 'PF mo'],
      rows: owners.slice(0, 12).map((o) => [
        o.owner, num(o.logins_wk), num(o.logins_pw),
        growthText(growth(Number(o.logins_wk), Number(o.logins_pw))),
        num(o.logins_mo), num(o.logins_pm),
        growthText(growth(Number(o.logins_mo), Number(o.logins_pm))),
        num(o.pf_wk), num(o.pf_mo)]),
    },
  });

  push({
    id: 'bd', eyebrow: 'BD PARTNERSHIPS', headline: (() => {
      const top = bd.filter((b) => b.bd !== '(no BD)')[0];
      const share = top ? pct(Number(top.logins_all), bdLoginTotal) : 0;
      return top ? `${top.bd} carries ${share}% of BD logins` : 'BD performance';
    })(),
    caption: 'Ranked by logins. Share is of all BD logins including unattributed.',
    chart: charts.bd,
    table: {
      head: ['BD', 'Logins', 'PF', 'Logins wk', 'WoW', 'Logins mo', 'MoM', 'Share', 'Leads'],
      rows: bd.slice(0, 12).map((b) => [
        b.bd, num(b.logins_all), num(b.pf_all),
        num(b.logins_wk), growthText(growth(Number(b.logins_wk), Number(b.logins_pw))),
        num(b.logins_mo), growthText(growth(Number(b.logins_mo), Number(b.logins_pm))),
        `${pct(Number(b.logins_all), bdLoginTotal)}%`, num(b.leads_all)]),
    },
  });

  push({
    id: 'leadmgmt', eyebrow: 'LEAD HYGIENE',
    headline: stale ? `${num(stale)} open leads untouched for over 30 days` : 'Contact recency',
    caption: `Measured from the most recent recorded event. ${pct(stale, touchTotal)}% of the live book.`,
    chart: charts.touch,
    table: {
      head: ['Time since last contact', 'Open leads', 'Share'],
      rows: (charts.touch.cats || []).map((b, i) => [
        b, num(charts.touch.series[0].values[i]),
        `${pct(charts.touch.series[0].values[i], touchTotal)}%`]),
    },
    table2: {
      title: 'Stage ageing',
      head: ['Age', 'Stage', 'Leads'],
      rows: (d.ageing || []).slice().sort((a, b) => Number(b.leads) - Number(a.leads))
        .slice(0, 12).map((a) => [a.bucket, a.stage_name, num(a.leads)]),
    },
  });

  push({
    id: 'targets', eyebrow: 'TARGETS', headline: 'Target versus achievement',
    awaiting: (d.targets || []).length === 0,
    awaitingReason: 'No targets set. Enter them on the Targets tab and this fills in automatically.',
    caption: 'Achievement and gap computed from the same figures as the rest of the deck.',
    table: {
      head: ['Scope', 'Metric', 'Period', 'Target', 'Achieved', 'Achievement', 'Gap'],
      rows: (d.targets || []).map((t) => {
        const src = t.period_type === 'week' ? cw : cm;
        const achieved = Number(src[t.metric] ?? 0);
        const target = Number(t.target_value);
        return [t.owner, METRIC_LABELS[t.metric] || t.metric, t.period_type,
          num(target), num(achieved), `${pct(achieved, target)}%`,
          num(Math.max(0, target - achieved))];
      }),
    },
  });

  push({
    id: 'pnl', eyebrow: 'P&L', headline: 'Profitability',
    awaiting: !d.pnl?.available, awaitingReason: d.pnl?.reason,
    caption: 'To be completed by hand until commission rules and a cost ledger exist.',
    table: {
      head: ['Line', 'This week', 'Last week', 'Month to date', 'Last month'],
      rows: [['Revenue', '', '', '', ''], ['— Consultancy commission', '', '', '', ''],
        ['— Lender payout', '', '', '', ''], ['Direct costs', '', '', '', ''],
        ['Gross contribution', '', '', '', ''], ['Operating costs', '', '', '', ''],
        ['Contribution margin %', '', '', '', ''], ['Cost per lead', '', '', '', ''],
        ['Revenue per disbursal', '', '', '', '']],
    },
    notes: [`Disbursed volume is the one financial figure the CRM holds: ${num(f.disbursed)} disbursals.`],
  });

  push({
    id: 'invoicing', eyebrow: 'INVOICING', headline: 'Receivables',
    awaiting: !d.invoicing?.available, awaitingReason: d.invoicing?.reason,
    caption: 'To be completed by hand until invoice records exist.',
    table: {
      head: ['Measure', 'Count', 'Amount', 'Notes'],
      rows: [['Invoices generated', '', '', ''], ['Invoices pending', '', '', ''],
        ['Invoices collected', '', '', ''], ['Outstanding', '', '', '']],
    },
    table2: { title: 'Receivables ageing', head: ['Bucket', 'Invoices', 'Amount'],
      rows: [['0-30 days', '', ''], ['31-60 days', '', ''], ['61-90 days', '', ''], ['90+ days', '', '']] },
  });

  return S;
}
