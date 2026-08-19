// =========================================================
// Weekly Business Review — deck builder
//
// Turns the JSON from weekly_review_data() into an 11-section deck, rendered
// on screen and exported to .pptx and PDF. Every number comes from that one
// payload, so the screen, the PowerPoint and the PDF cannot disagree.
//
// Sections with no data source in the CRM (P&L, Invoicing) still get their
// full slide, laid out with the right rows and columns and marked as
// awaiting input, so they can be filled in by hand. They are never populated
// with invented figures.
// =========================================================

export const BRAND = {
  navy: '101B30',
  blue: '2563EB',
  blueDark: '1D4ED8',
  soft: 'DBE7FE',
  ink: '1F2937',
  muted: '6B7280',
  line: 'E5E7EB',
  good: '15803D',
  bad: 'B91C1C',
  warn: 'B45309',
  paper: 'FFFFFF',
};

const METRIC_LABELS = {
  leads: 'Leads', logins: 'Logins', sanctions: 'Sanctions',
  pf: 'PF Paid', disbursals: 'Disbursals', disbursed_value: 'Disbursed value',
};

// ---------------------------------------------------------
// Small helpers
// ---------------------------------------------------------
export const num = (n) => Number(n ?? 0).toLocaleString('en-IN');
export const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Growth as a signed percentage. Returns null when the base is zero, so
 *  "up from nothing" is never rendered as a meaningless +Infinity%. */
export function growth(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export function growthText(g) {
  if (g === null) return 'n/a';
  return `${g > 0 ? '+' : ''}${g}%`;
}

const fmtDate = (d) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

// ---------------------------------------------------------
// Commentary
//
// Written from the numbers rather than from a language model: the rules are
// auditable, they cannot hallucinate a figure, and they run offline. Each
// returns {tone, text} so the UI can colour it.
// ---------------------------------------------------------
export function buildInsights(d) {
  const out = [];
  const cw = d.periods.current_week, pw = d.periods.previous_week;
  const cm = d.periods.current_month, pm = d.periods.previous_month;

  const gLeads = growth(cw.leads, pw.leads);
  const gLogins = growth(cw.logins, pw.logins);
  const gPf = growth(cw.pf, pw.pf);

  const gSanc = growth(cw.sanctions, pw.sanctions);

  if (gLogins !== null) {
    out.push({
      tone: gLogins >= 0 ? 'good' : 'bad',
      text: `Logins ${gLogins >= 0 ? 'rose' : 'fell'} ${Math.abs(gLogins)}% week on week — `
        + `${num(cw.logins)} against ${num(pw.logins)}.`,
    });
  }
  if (gSanc !== null) {
    out.push({
      tone: gSanc >= 0 ? 'good' : 'bad',
      text: `Sanctions ${gSanc >= 0 ? 'rose' : 'fell'} ${Math.abs(gSanc)}% — `
        + `${num(cw.sanctions)} against ${num(pw.sanctions)}.`,
    });
  }
  // Intake up while conversion falls is the pattern worth naming: it looks
  // like growth on the top line and is not.
  if (gLeads !== null && gLogins !== null && gLeads > 5 && gLogins < -5) {
    out.push({
      tone: 'bad',
      text: `Lead intake grew ${gLeads}% while logins fell ${Math.abs(gLogins)}%. More is arriving and less `
        + `is converting, so the top-line increase is not reaching the funnel.`,
    });
  }
  if (gPf !== null) {
    out.push({
      tone: gPf >= 0 ? 'good' : 'warn',
      text: `PF paid ${gPf >= 0 ? 'up' : 'down'} ${Math.abs(gPf)}% week on week (${num(cw.pf)} vs ${num(pw.pf)}).`,
    });
  }

  // Month pacing, elapsed-day adjusted so a part-month is not read as a slump.
  const mStart = new Date(d.meta.month_start + 'T00:00:00');
  const mEnd = new Date(d.meta.month_end + 'T00:00:00');
  const elapsed = Math.round((mEnd - mStart) / 86400000) + 1;
  const daysInPrev = new Date(new Date(d.meta.prev_month_start + 'T00:00:00').getFullYear(),
    new Date(d.meta.prev_month_start + 'T00:00:00').getMonth() + 1, 0).getDate();
  const runRate = elapsed ? (cm.logins / elapsed) * daysInPrev : 0;
  const pace = growth(runRate, pm.logins);
  if (pace !== null) {
    out.push({
      tone: pace >= 0 ? 'good' : 'warn',
      text: `Month to date is ${num(cm.logins)} logins over ${elapsed} days. At this rate the month lands `
        + `near ${num(Math.round(runRate))} against last month's ${num(pm.logins)} (${growthText(pace)}).`,
    });
  }

  // Touchbase — usually the sharpest finding in the deck.
  const stale = (d.touchbase || [])
    .filter((b) => b.bucket === '31-60 days' || b.bucket === '60+ days')
    .reduce((s, b) => s + Number(b.leads), 0);
  const touchTotal = (d.touchbase || []).reduce((s, b) => s + Number(b.leads), 0);
  if (stale > 0) {
    out.push({
      tone: stale / touchTotal > 0.15 ? 'bad' : 'warn',
      text: `${num(stale)} open leads (${pct(stale, touchTotal)}% of the live book) have gone untouched `
        + `for more than 30 days.`,
    });
  }

  // Funnel drop-offs.
  const f = d.funnel;
  if (f.login && f.sanction) {
    const conv = pct(f.sanction, f.login);
    out.push({
      tone: conv < 40 ? 'warn' : 'good',
      text: `Login to sanction converts at ${conv}%. ${num(f.login - f.sanction)} logged-in leads have not `
        + `reached sanction.`,
    });
  }
  if (f.login_undated) {
    out.push({
      tone: 'warn',
      text: `${num(f.login_undated)} leads sit at Login or beyond with no login date recorded, so they `
        + `cannot be placed in any week. Period figures understate activity by that much.`,
    });
  }

  // TAT.
  if (d.tat?.create_to_login) {
    out.push({
      tone: d.tat.create_to_login > 30 ? 'warn' : 'good',
      text: `Average time from lead created to login is ${d.tat.create_to_login} days.`,
    });
  }

  // Concentration risk.
  const bd = (d.bd || []).filter((b) => b.bd !== '(no BD)');
  const bdTotal = bd.reduce((s, b) => s + Number(b.logins_all), 0);
  if (bd.length && bdTotal) {
    const top = bd.slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all))[0];
    const share = pct(Number(top.logins_all), bdTotal);
    if (share > 25) {
      out.push({
        tone: 'warn',
        text: `${top.bd} accounts for ${share}% of all BD logins. That is concentration risk in one relationship.`,
      });
    }
  }
  const noBd = (d.bd || []).find((b) => b.bd === '(no BD)');
  if (noBd && Number(noBd.logins_all) > 0) {
    out.push({
      tone: 'warn',
      text: `${num(noBd.logins_all)} logins are credited to nobody — the leads behind them carry no BD name.`,
    });
  }

  // Data quality caveats that change how the deck should be read.
  const dq = d.data_quality || {};
  if (dq.users_with_team < dq.users_total) {
    out.push({
      tone: 'warn',
      text: `Only ${dq.users_with_team} of ${dq.users_total} active users are assigned to a team, so any `
        + `Bangalore/Hyderabad split is unreliable.`,
    });
  }
  if (!Number(dq.disbursed_value_recorded)) {
    out.push({
      tone: 'bad',
      text: `No disbursed amounts are recorded anywhere, so disbursed value reads zero. Volume figures are `
        + `real; the rupee figures are not yet captured.`,
    });
  }
  return out;
}

/** Split insights into the three executive buckets. */
export function categorise(insights) {
  return {
    wins: insights.filter((i) => i.tone === 'good'),
    risks: insights.filter((i) => i.tone === 'bad'),
    watch: insights.filter((i) => i.tone === 'warn'),
  };
}

// ---------------------------------------------------------
// Chart rendering (Chart.js → PNG data URL for the pptx)
// ---------------------------------------------------------
function chartCanvas(width = 900, height = 460) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  // Charts must render on white: a transparent PNG on a white slide loses
  // every dark-theme label.
  c.style.background = '#FFFFFF';
  return c;
}

const CHART_BASE = {
  responsive: false,
  animation: false,
  plugins: { legend: { labels: { color: '#1F2937', font: { size: 13 } } } },
  scales: {
    x: { ticks: { color: '#374151', font: { size: 12 } }, grid: { color: '#EEF2F7' } },
    y: { ticks: { color: '#374151', font: { size: 12 } }, grid: { color: '#EEF2F7' }, beginAtZero: true },
  },
};

/** Render a chart off-screen and return {canvas, dataUrl}. */
export async function renderChart(config, w, h) {
  const canvas = chartCanvas(w, h);
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;';
  holder.appendChild(canvas);
  document.body.appendChild(holder);

  // eslint-disable-next-line no-undef
  const chart = new Chart(canvas.getContext('2d'), config);
  // With animation off Chart.js has already drawn by the time the
  // constructor returns. Yield once via a timer rather than
  // requestAnimationFrame: rAF is paused in a hidden or backgrounded tab, so
  // waiting on a frame here would hang generation the moment someone
  // switched tabs. A macrotask always runs.
  chart.draw();
  await new Promise((r) => setTimeout(r, 0));

  // Paint the white ground behind the chart so the PNG is not transparent.
  const out = chartCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  const dataUrl = out.toDataURL('image/png');

  chart.destroy();
  holder.remove();
  return { dataUrl, width: out.width, height: out.height };
}

export function buildChartConfigs(d) {
  const cw = d.periods.current_week, pw = d.periods.previous_week;
  const cm = d.periods.current_month, pm = d.periods.previous_month;
  const f = d.funnel;

  // Ranked by logins, not leads. Lead count measures how much was fed in;
  // logins measure what the person actually converted, which is what a
  // performance chart should order by.
  const owners = (d.owners || []).filter((o) => o.owner !== 'Unassigned')
    .slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all)).slice(0, 10);
  const bd = (d.bd || []).filter((b) => b.bd !== '(no BD)')
    .slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all)).slice(0, 10);
  const touch = d.touchbase || [];
  const TOUCH_ORDER = ['0-7 days', '8-14 days', '15-30 days', '31-60 days', '60+ days'];
  const touchSorted = TOUCH_ORDER
    .map((b) => touch.find((t) => t.bucket === b))
    .filter(Boolean);

  return {
    wow: {
      type: 'bar',
      data: {
        labels: ['Logins', 'Sanctions', 'PF paid'],
        datasets: [
          { label: `Previous week (${fmtDate(d.meta.prev_week_start)}–${fmtDate(d.meta.prev_week_end)})`,
            data: [pw.logins, pw.sanctions, pw.pf], backgroundColor: '#C7D6F5' },
          { label: `Current week (${fmtDate(d.meta.week_start)}–${fmtDate(d.meta.week_end)})`,
            data: [cw.logins, cw.sanctions, cw.pf], backgroundColor: '#2563EB' },
        ],
      },
      options: CHART_BASE,
    },
    mom: {
      type: 'bar',
      data: {
        labels: ['Logins', 'Sanctions', 'PF paid'],
        datasets: [
          { label: 'Previous month', data: [pm.logins, pm.sanctions, pm.pf], backgroundColor: '#C7D6F5' },
          { label: 'Month to date', data: [cm.logins, cm.sanctions, cm.pf], backgroundColor: '#1D4ED8' },
        ],
      },
      options: CHART_BASE,
    },
    funnel: {
      type: 'bar',
      data: {
        labels: ['Leads', 'App Start', 'Bank Prospect', 'Login', 'Sanction', 'PF Paid', 'Disbursed'],
        datasets: [{
          label: 'Leads reaching this stage',
          data: [f.total_leads, f.app_start, f.bank_prospect, f.login, f.sanction, f.pf, f.disbursed],
          backgroundColor: ['#101B30', '#1E3A8A', '#1D4ED8', '#2563EB', '#3B82F6', '#60A5FA', '#93C5FD'],
        }],
      },
      options: { ...CHART_BASE, indexAxis: 'y', plugins: { legend: { display: false } } },
    },
    owners: {
      type: 'bar',
      data: {
        labels: owners.map((o) => o.owner),
        datasets: [
          { label: 'Logins', data: owners.map((o) => Number(o.logins_all)), backgroundColor: '#2563EB' },
          { label: 'PF paid', data: owners.map((o) => Number(o.pf_all)), backgroundColor: '#60A5FA' },
        ],
      },
      options: CHART_BASE,
    },
    bd: {
      type: 'bar',
      data: {
        labels: bd.map((b) => b.bd),
        datasets: [
          { label: 'Logins', data: bd.map((b) => Number(b.logins_all)), backgroundColor: '#1D4ED8' },
          { label: 'PF paid', data: bd.map((b) => Number(b.pf_all)), backgroundColor: '#60A5FA' },
        ],
      },
      options: CHART_BASE,
    },
    touch: {
      type: 'bar',
      data: {
        labels: touchSorted.map((t) => t.bucket),
        datasets: [{
          label: 'Open leads by time since last touch',
          data: touchSorted.map((t) => Number(t.leads)),
          backgroundColor: ['#15803D', '#65A30D', '#CA8A04', '#EA580C', '#B91C1C'],
        }],
      },
      options: { ...CHART_BASE, plugins: { legend: { display: false } } },
    },
    tat: {
      type: 'bar',
      data: {
        labels: ['Created → Login', 'Login → Sanction', 'Sanction → PF', 'PF → Disbursal'],
        datasets: [{
          label: 'Average days',
          data: [d.tat?.create_to_login ?? 0, d.tat?.login_to_sanction ?? 0,
                 d.tat?.sanction_to_pf ?? 0, d.tat?.pf_to_disbursal ?? 0],
          backgroundColor: '#2563EB',
        }],
      },
      options: { ...CHART_BASE, plugins: { legend: { display: false } } },
    },
  };
}

// ---------------------------------------------------------
// Section model — drives both the on-screen deck and the pptx, so the two
// can never drift apart.
// ---------------------------------------------------------
export function buildSections(d, charts) {
  const cw = d.periods.current_week, pw = d.periods.previous_week;
  const cm = d.periods.current_month, pm = d.periods.previous_month;
  const f = d.funnel;
  const insights = buildInsights(d);
  const { wins, risks, watch } = categorise(insights);

  const metricRow = (label, a, b) => {
    const g = growth(a, b);
    return [label, num(a), num(b), growthText(g), g === null ? 'flat' : (g >= 0 ? 'up' : 'down')];
  };

  // Ordered and attributed by logins throughout: lead volume says how much
  // was handed to someone, logins say what they did with it.
  const owners = (d.owners || []).filter((o) => o.owner !== 'Unassigned')
    .slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all));
  const ownerLoginTotal = owners.reduce((s, o) => s + Number(o.logins_all), 0);
  const bd = (d.bd || []).slice().sort((a, b) => Number(b.logins_all) - Number(a.logins_all));
  const bdLoginTotal = bd.reduce((s, b) => s + Number(b.logins_all), 0);

  const stagePairs = [
    ['Leads → App Start', f.total_leads, f.app_start],
    ['App Start → Bank Prospect', f.app_start, f.bank_prospect],
    ['Bank Prospect → Login', f.bank_prospect, f.login],
    ['Login → Sanction', f.login, f.sanction],
    ['Sanction → PF Paid', f.sanction, f.pf],
    ['PF Paid → Disbursed', f.pf, f.disbursed],
  ];

  return [
    {
      id: 'exec',
      title: 'Executive summary',
      subtitle: `Week ${fmtDate(d.meta.week_start)} – ${fmtDate(d.meta.week_end)}`,
      // Logins and PF lead: they are what the week is judged on. Lead intake
      // is shown last, as context for the conversion numbers rather than as
      // the headline.
      kpis: [
        { label: 'Logins this week', value: num(cw.logins), delta: growthText(growth(cw.logins, pw.logins)) },
        { label: 'PF paid', value: num(cw.pf), delta: growthText(growth(cw.pf, pw.pf)) },
        { label: 'Sanctions', value: num(cw.sanctions), delta: growthText(growth(cw.sanctions, pw.sanctions)) },
        { label: 'Leads in (context)', value: num(cw.leads), delta: growthText(growth(cw.leads, pw.leads)) },
      ],
      lists: [
        { heading: 'Key wins', tone: 'good', items: wins.map((i) => i.text) },
        { heading: 'Risks and blockers', tone: 'bad', items: risks.map((i) => i.text) },
        { heading: 'Watch closely', tone: 'warn', items: watch.map((i) => i.text) },
      ],
    },
    {
      id: 'overall',
      title: 'Overall numbers',
      table: {
        head: ['Metric', 'This week', 'Last week', 'WoW', 'Month to date', 'Last month', 'MoM'],
        rows: ['logins', 'sanctions', 'pf', 'disbursals', 'leads'].map((k) => [
          METRIC_LABELS[k], num(cw[k]), num(pw[k]), growthText(growth(cw[k], pw[k])),
          num(cm[k]), num(pm[k]), growthText(growth(cm[k], pm[k])),
        ]),
      },
      notes: [
        `Pre-login book: ${num(f.total_leads - f.login)} leads have not yet logged in.`,
        `Post-login book: ${num(f.login)} leads are at Login or beyond.`,
        Number(d.data_quality?.disbursed_value_recorded)
          ? `Disbursed value recorded: ₹${num(d.data_quality.disbursed_value_recorded)}.`
          : 'Disbursed value is not captured in the CRM yet, so revenue and invoicing cannot be derived from it.',
      ],
    },
    {
      id: 'owners',
      title: 'Owner-wise performance',
      chart: charts.owners,
      table: {
        head: ['Owner', 'Logins', 'PF', 'Login→PF %', 'Share of logins', 'Leads (context)'],
        rows: owners.slice(0, 15).map((o) => [
          o.owner, num(o.logins_all), num(o.pf_all),
          `${pct(Number(o.pf_all), Number(o.logins_all))}%`,
          `${pct(Number(o.logins_all), ownerLoginTotal)}%`,
          num(o.leads_all),
        ]),
      },
    },
    {
      id: 'periods',
      title: 'Weekly and monthly performance',
      chart: charts.wow,
      chart2: charts.mom,
      table: {
        head: ['Metric', 'Current', 'Previous', 'Change', 'Direction'],
        rows: [
          metricRow('Logins (week)', cw.logins, pw.logins),
          metricRow('Sanctions (week)', cw.sanctions, pw.sanctions),
          metricRow('PF (week)', cw.pf, pw.pf),
          metricRow('Logins (month)', cm.logins, pm.logins),
          metricRow('Sanctions (month)', cm.sanctions, pm.sanctions),
          metricRow('PF (month)', cm.pf, pm.pf),
        ].map((r) => r.slice(0, 5)),
      },
      notes: ['Month to date covers a part month; compare the run rate, not the raw total.'],
    },
    {
      id: 'owner-periods',
      title: 'Owner-wise weekly and monthly analysis',
      table: {
        head: ['Owner', 'Logins wk', 'Prev wk', 'WoW', 'Logins mo', 'Prev mo', 'MoM', 'PF wk', 'PF mo'],
        rows: owners.slice(0, 15).map((o) => [
          o.owner,
          num(o.logins_wk), num(o.logins_pw), growthText(growth(Number(o.logins_wk), Number(o.logins_pw))),
          num(o.logins_mo), num(o.logins_pm), growthText(growth(Number(o.logins_mo), Number(o.logins_pm))),
          num(o.pf_wk), num(o.pf_mo),
        ]),
      },
    },
    {
      id: 'targets',
      title: 'Target vs achievement',
      awaiting: (d.targets || []).length === 0,
      awaitingReason:
        'No targets have been set. Enter weekly or monthly targets on the Targets tab and this section '
        + 'fills in automatically — the achievement and gap columns are computed from the same numbers as '
        + 'the rest of the deck.',
      table: {
        head: ['Scope', 'Metric', 'Period', 'Target', 'Achieved', 'Achievement %', 'Gap'],
        rows: (d.targets || []).map((t) => {
          const src = t.period_type === 'week' ? cw : cm;
          const achieved = Number(src[t.metric] ?? 0);
          const target = Number(t.target_value);
          return [
            t.owner, METRIC_LABELS[t.metric] || t.metric, t.period_type,
            num(target), num(achieved),
            `${pct(achieved, target)}%`,
            num(Math.max(0, target - achieved)),
          ];
        }),
      },
    },
    {
      id: 'leadmgmt',
      title: 'Lead management analysis',
      chart: charts.touch,
      table: {
        head: ['Time since last touch', 'Open leads', 'Share'],
        rows: (() => {
          const total = (d.touchbase || []).reduce((s, b) => s + Number(b.leads), 0);
          const ORDER = ['0-7 days', '8-14 days', '15-30 days', '31-60 days', '60+ days'];
          return ORDER
            .map((b) => (d.touchbase || []).find((t) => t.bucket === b))
            .filter(Boolean)
            .map((t) => [t.bucket, num(t.leads), `${pct(Number(t.leads), total)}%`]);
        })(),
      },
      table2: {
        title: 'Stage ageing (open leads)',
        head: ['Age', 'Stage', 'Leads'],
        rows: (d.ageing || [])
          .sort((a, b) => Number(b.leads) - Number(a.leads))
          .slice(0, 14)
          .map((a) => [a.bucket, a.stage_name, num(a.leads)]),
      },
      notes: ['Touchbase is measured from the most recent recorded event on the lead.'],
    },
    {
      id: 'bd',
      title: 'BD performance dashboard',
      chart: charts.bd,
      table: {
        head: ['BD', 'Logins', 'PF', 'Logins wk', 'WoW', 'Logins mo', 'MoM', 'Share of logins', 'Leads (context)'],
        rows: bd.slice(0, 15).map((b) => [
          b.bd, num(b.logins_all), num(b.pf_all),
          num(b.logins_wk), growthText(growth(Number(b.logins_wk), Number(b.logins_pw))),
          num(b.logins_mo), growthText(growth(Number(b.logins_mo), Number(b.logins_pm))),
          `${pct(Number(b.logins_all), bdLoginTotal)}%`,
          num(b.leads_all),
        ]),
      },
    },
    {
      id: 'funnel',
      title: 'Funnel analysis',
      chart: charts.funnel,
      chart2: charts.tat,
      table: {
        head: ['Transition', 'From', 'To', 'Conversion %', 'Drop-off'],
        rows: stagePairs.map(([label, from, to]) => [
          label, num(from), num(to), `${pct(to, from)}%`, num(Math.max(0, from - to)),
        ]),
      },
      notes: [
        `Pre-login funnel: ${num(f.total_leads)} → ${num(f.app_start)} → ${num(f.bank_prospect)} → ${num(f.login)}.`,
        `Post-login funnel: ${num(f.login)} → ${num(f.sanction)} → ${num(f.pf)} → ${num(f.disbursed)}.`,
        `${num(f.login_undated)} leads are at Login or beyond with no login date, and ${num(f.pf_undated)} at PF with no PF date.`,
        `Lost: ${num(f.lost)} leads.`,
      ],
    },
    {
      id: 'pnl',
      title: 'P&L dashboard',
      awaiting: !d.pnl?.available,
      awaitingReason: d.pnl?.reason,
      table: {
        head: ['Line', 'This week', 'Last week', 'Month to date', 'Last month'],
        rows: [
          ['Revenue', '', '', '', ''],
          ['— Consultancy commission', '', '', '', ''],
          ['— Lender payout', '', '', '', ''],
          ['Direct costs', '', '', '', ''],
          ['Gross contribution', '', '', '', ''],
          ['Operating costs', '', '', '', ''],
          ['Contribution margin %', '', '', '', ''],
          ['Cost per lead', '', '', '', ''],
          ['Revenue per disbursal', '', '', '', ''],
        ],
      },
      notes: [
        `Disbursed volume is the one financial figure the CRM holds: ${num(f.disbursed)} disbursals recorded.`,
        'Fill the rows above by hand, or set up commission rules and a cost ledger and this section computes itself.',
      ],
    },
    {
      id: 'invoicing',
      title: 'Invoicing dashboard',
      awaiting: !d.invoicing?.available,
      awaitingReason: d.invoicing?.reason,
      table: {
        head: ['Measure', 'Count', 'Amount', 'Notes'],
        rows: [
          ['Invoices generated', '', '', ''],
          ['Invoices pending', '', '', ''],
          ['Invoices collected', '', '', ''],
          ['Outstanding', '', '', ''],
        ],
      },
      table2: {
        title: 'Receivables ageing',
        head: ['Bucket', 'Invoices', 'Amount'],
        rows: [['0-30 days', '', ''], ['31-60 days', '', ''], ['61-90 days', '', ''], ['90+ days', '', '']],
      },
    },
  ];
}
