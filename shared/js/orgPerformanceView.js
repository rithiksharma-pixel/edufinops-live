// =========================================================
// SHARED — performance by SOURCE and by BRANCH / TEAM
//
// One component, mounted on the Admin Console, the Manager Dashboard and the
// RM Workspace, so all three show the same numbers from the same feed.
// Everything is rolled up client-side from org_performance() (deployment/066),
// which returns one row per RM per lead source — the source table, the
// branch table and the source filter on the branch table are all sums over
// the same rows, so they can never disagree with one another.
//
// Counting rules are rm_performance()'s: leads by created date, milestones by
// the lead's own login / sanction / PF / disbursement date.
//
// Org shape (from the reporting tree, not hardcoded):
//   Branch   — teams.branch, headed by teams.lead_user_id (Julius, Pandey)
//   Sub-team — whoever an RM reports to, when that is not the branch lead
//              (Ajay Kumar, Shivam Kumar); otherwise "reports to <lead>"
//   RM
// =========================================================
import { escapeHtml } from './utils.js';
import { emptyState } from './emptyState.js';
import { renderInsights, topNInsight, shareInsight } from './insights.js';

const PERIODS = [
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'all', label: 'All time' },
];

// Local-date parts, not toISOString(): in IST, local midnight on the 1st is
// the previous day in UTC and every "this month" would start a day early.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function rangeFor(period) {
  const t = new Date();
  if (period === 'month') return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) };
  if (period === 'last-month') {
    return { from: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: iso(new Date(t.getFullYear(), t.getMonth(), 0)) };
  }
  if (period === 'quarter') {
    const q = Math.floor(t.getMonth() / 3) * 3;
    return { from: iso(new Date(t.getFullYear(), q, 1)), to: iso(t) };
  }
  return { from: null, to: null };
}

const n = (v) => Number(v || 0).toLocaleString('en-IN');
const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(1)}%` : '–');
function inr(v) {
  if (!v) return '–';
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

const METRICS = ['leads', 'logins', 'sanctions', 'pf', 'disbursed', 'disbursed_amount'];
const blank = () => Object.fromEntries(METRICS.map((m) => [m, 0]));
function add(into, row) { METRICS.forEach((m) => { into[m] += Number(row[m] || 0); }); return into; }
const isReferral = (row) => /referral/i.test(row.source_name || '');

/** Groups rows by key(row), summing metrics; `meta` fills labels once. */
function rollup(rows, key, meta = () => ({})) {
  const map = new Map();
  rows.forEach((r) => {
    const k = key(r);
    if (!map.has(k)) map.set(k, { key: k, ...meta(r), ...blank(), referralLogins: 0, referralPf: 0 });
    const g = map.get(k);
    add(g, r);
    if (isReferral(r)) { g.referralLogins += Number(r.logins || 0); g.referralPf += Number(r.pf || 0); }
  });
  return [...map.values()];
}

/** Share of the column's total, as a bar and a figure. */
function shareBar(value, total) {
  const share = total ? (value / total) * 100 : 0;
  return `<span class="pp-meter"><span class="pp-meter-track"><span class="pp-meter-fill" style="width:${Math.max(2, share)}%;background:var(--accent);"></span></span><span class="pp-meter-text">${share.toFixed(0)}%</span></span>`;
}

/** A rate reads as good or bad only against the whole org's own rate. */
function rateCell(num, den, avg) {
  if (!den) return '<td class="r pp-muted">–</td>';
  const v = (num / den) * 100;
  const color = avg && v >= avg * 1.15 ? 'var(--success)' : avg && v <= avg * 0.7 ? 'var(--danger)' : 'inherit';
  return `<td class="r pp-num" style="color:${color}">${v.toFixed(1)}%</td>`;
}

export function mountOrgPerformance({ host, supabase, scope = 'org', userId = null, title = null }) {
  if (!host) return;
  const state = { period: 'month', source: '', rows: [], open: new Set(), loading: false };
  const mine = scope === 'rm';

  host.innerHTML = `
    <section class="pp-panel org-perf">
      <div class="pp-card-title pp-card-title-row">
        <div>
          <h3>${escapeHtml(title || (mine ? 'My leads by source' : 'Performance by source and branch'))}</h3>
          <p>${mine
            ? 'Where your leads came from, and how each source is converting for you.'
            : 'Where the volume comes from, and which branch and team is converting it. Click a branch or team to see its people.'}</p>
        </div>
        <div class="pp-tabs" data-op-periods>${PERIODS.map((p) => `<button type="button" class="pp-tab ${p.id === state.period ? 'on' : ''}" data-op-period="${p.id}">${p.label}</button>`).join('')}</div>
      </div>
      <div data-op-body><div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div></div>
    </section>`;

  host.querySelectorAll('[data-op-period]').forEach((b) => b.addEventListener('click', () => {
    state.period = b.dataset.opPeriod;
    host.querySelectorAll('[data-op-period]').forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));

  async function load() {
    const body = host.querySelector('[data-op-body]');
    body.innerHTML = '<div class="spinner-block"><span class="spinner"></span><span>Loading…</span></div>';
    const { from, to } = rangeFor(state.period);
    const { data, error } = await supabase.rpc('org_performance', { p_from: from, p_to: to });
    if (error) {
      body.innerHTML = emptyState('fa-triangle-exclamation', 'Could not load performance', error.message || 'Try refreshing the page.');
      return;
    }
    state.rows = (data || []).filter((r) => !mine || r.rm_id === userId);
    render();
  }

  function sourceTable() {
    const groups = rollup(state.rows, (r) => r.source_name, (r) => ({ label: r.source_name, category: r.source_category }))
      .sort((a, b) => b.logins - a.logins || b.leads - a.leads);
    const tot = groups.reduce((t, g) => add(t, g), blank());
    const avgLL = tot.leads ? (tot.logins / tot.leads) * 100 : 0;
    const avgLP = tot.logins ? (tot.pf / tot.logins) * 100 : 0;
    const branches = mine ? [] : [...new Set(state.rows.map((r) => r.branch).filter(Boolean))].sort();
    const byBranch = (source, branch) => state.rows
      .filter((r) => r.source_name === source && r.branch === branch)
      .reduce((s, r) => s + Number(r.logins || 0), 0);

    if (!groups.length || (!tot.leads && !tot.logins)) {
      return emptyState('fa-chart-simple', 'Nothing in this period', 'Try a wider period.');
    }
    const unknown = groups.find((g) => g.label === 'Unknown');
    return `
      <div class="pp-table-wrap"><table class="pp-table org-perf-table">
        <thead><tr>
          <th>Source</th><th class="r">Leads</th><th class="r">Logins</th><th>Share of logins</th>
          <th class="r">Lead→Login</th><th class="r">PF</th><th class="r">Login→PF</th><th class="r">Disbursed</th>
          ${branches.map((b) => `<th class="r">${escapeHtml(b)} logins</th>`).join('')}
        </tr></thead>
        <tbody>${groups.map((g) => `
          <tr class="${g.label === 'Unknown' ? 'is-gap' : ''}">
            <td><div class="pp-name">${escapeHtml(g.label)}${isReferral({ source_name: g.label }) ? ' <span class="pp-chip accent">Referral</span>' : ''}${g.label === 'Unknown' ? ' <span class="pp-chip warn">No source recorded</span>' : ''}</div></td>
            <td class="r pp-num">${n(g.leads)}</td>
            <td class="r pp-num"><strong>${n(g.logins)}</strong></td>
            <td>${shareBar(g.logins, tot.logins)}</td>
            ${rateCell(g.logins, g.leads, avgLL)}
            <td class="r pp-num">${n(g.pf)}</td>
            ${rateCell(g.pf, g.logins, avgLP)}
            <td class="r pp-num">${inr(g.disbursed_amount)}</td>
            ${branches.map((b) => `<td class="r pp-num">${n(byBranch(g.label, b))}</td>`).join('')}
          </tr>`).join('')}
          <tr class="is-total">
            <td><strong>All sources</strong></td>
            <td class="r pp-num">${n(tot.leads)}</td><td class="r pp-num"><strong>${n(tot.logins)}</strong></td><td></td>
            <td class="r pp-num">${pct(tot.logins, tot.leads)}</td><td class="r pp-num">${n(tot.pf)}</td>
            <td class="r pp-num">${pct(tot.pf, tot.logins)}</td><td class="r pp-num">${inr(tot.disbursed_amount)}</td>
            ${branches.map((b) => `<td class="r pp-num">${n(state.rows.filter((r) => r.branch === b).reduce((s, r) => s + Number(r.logins || 0), 0))}</td>`).join('')}
          </tr>
        </tbody>
      </table></div>
      ${unknown && unknown.leads && tot.leads ? `<p class="org-perf-note">${n(unknown.leads)} of ${n(tot.leads)} leads in this period (${pct(unknown.leads, tot.leads)}) have no source recorded, so every source above reads lower than it really is.</p>` : ''}`;
  }

  function branchTable() {
    const rows = state.rows.filter((r) => !state.source || r.source_name === state.source);
    // Who manages whom, from the rows themselves: anyone who appears as a
    // manager of an RM heads a sub-team, unless they head the whole branch.
    const leads = new Set(rows.map((r) => r.branch_lead_id).filter(Boolean));
    const subTeamOf = (r) => {
      if (!r.rm_id) return { id: 'unassigned', label: 'Not assigned to an RM' };
      const managesOthers = rows.some((x) => x.manager_id === r.rm_id);
      if (managesOthers && !leads.has(r.rm_id)) return { id: r.rm_id, label: `${r.rm_name}'s team` };
      if (r.manager_id && !leads.has(r.manager_id)) return { id: r.manager_id, label: `${r.manager_name}'s team` };
      return { id: `direct:${r.branch_lead_id || 'none'}`, label: r.branch_lead_name ? `${r.branch_lead_name} & direct reports` : 'No manager set' };
    };
    const branchKey = (r) => r.branch || '(no branch)';

    const branches = rollup(rows, branchKey, (r) => ({ label: r.branch || 'No branch', leadName: r.branch_lead_name }))
      .sort((a, b) => (a.label === 'No branch') - (b.label === 'No branch') || b.logins - a.logins);
    const tot = branches.reduce((t, g) => add(t, g), blank());
    const avgLL = tot.leads ? (tot.logins / tot.leads) * 100 : 0;
    const avgLP = tot.logins ? (tot.pf / tot.logins) * 100 : 0;

    const cells = (g) => `
      <td class="r pp-num">${n(g.leads)}</td>
      <td class="r pp-num"><strong>${n(g.logins)}</strong></td>
      <td>${shareBar(g.logins, tot.logins)}</td>
      ${rateCell(g.logins, g.leads, avgLL)}
      <td class="r pp-num">${n(g.pf)}</td>
      ${rateCell(g.pf, g.logins, avgLP)}
      <td class="r pp-num">${inr(g.disbursed_amount)}</td>
      <td class="r pp-num">${n(g.referralLogins)}</td>`;

    const body = branches.map((b) => {
      const bRows = rows.filter((r) => branchKey(r) === b.key);
      const bOpen = !state.open.has(`closed:${b.key}`);
      const subs = rollup(bRows, (r) => subTeamOf(r).id, (r) => ({ label: subTeamOf(r).label }))
        .sort((a, c) => c.logins - a.logins);
      return `
        <tr class="lvl-branch" data-op-toggle="closed:${escapeHtml(b.key)}">
          <td><i class="fa-solid fa-caret-${bOpen ? 'down' : 'right'} lvl-caret"></i><span class="pp-name">${escapeHtml(b.label)}</span>${b.leadName ? `<span class="pp-sub">Led by ${escapeHtml(b.leadName)}</span>` : ''}</td>
          ${cells(b)}
        </tr>
        ${bOpen ? subs.map((s) => {
          const sKey = `${b.key}|${s.key}`;
          const sOpen = state.open.has(sKey);
          const people = rollup(bRows.filter((r) => subTeamOf(r).id === s.key), (r) => r.rm_id || 'none', (r) => ({ label: r.rm_name }))
            .sort((a, c) => c.logins - a.logins);
          return `
            <tr class="lvl-team" data-op-toggle="${escapeHtml(sKey)}">
              <td><i class="fa-solid fa-caret-${sOpen ? 'down' : 'right'} lvl-caret"></i>${escapeHtml(s.label)} <span class="pp-sub-inline">${people.length} ${people.length === 1 ? 'person' : 'people'}</span></td>
              ${cells(s)}
            </tr>
            ${sOpen ? people.map((p) => `
              <tr class="lvl-rm"><td>${escapeHtml(p.label)}</td>${cells(p)}</tr>`).join('') : ''}`;
        }).join('') : ''}`;
    }).join('');

    const sources = [...new Set(state.rows.map((r) => r.source_name))].sort();
    return `
      <div class="org-perf-sub">
        <div><h4>By branch and team</h4><p>Ranked by logins. Rates are coloured against the whole company's own rate.</p></div>
        <select class="org-perf-select" data-op-source>
          <option value="">All sources</option>
          ${sources.map((s) => `<option value="${escapeHtml(s)}" ${s === state.source ? 'selected' : ''}>${escapeHtml(s)} only</option>`).join('')}
        </select>
      </div>
      <div class="pp-table-wrap"><table class="pp-table org-perf-table">
        <thead><tr>
          <th>Branch · team · RM</th><th class="r">Leads</th><th class="r">Logins</th><th>Share of logins</th>
          <th class="r">Lead→Login</th><th class="r">PF</th><th class="r">Login→PF</th><th class="r">Disbursed</th><th class="r">Referral logins</th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="9">${emptyState('fa-people-group', 'Nothing in this period', 'Try a wider period or another source.')}</td></tr>`}</tbody>
      </table></div>`;
  }

  /**
   * The sentences on top: computed from the same rows as the tables below,
   * for the same period, so they change when the period does.
   */
  function insights() {
    const rows = state.rows;
    const sum = (list, k) => list.reduce((t, r) => t + Number(r[k] || 0), 0);
    const logins = sum(rows, 'logins');
    const leads = sum(rows, 'leads');
    const bySource = rollup(rows, (r) => r.source_name, (r) => ({ label: r.source_name })).sort((a, b) => b.logins - a.logins);
    const topSource = bySource[0];
    const unknown = bySource.find((g) => g.label === 'Unknown');

    if (mine) {
      const known = bySource.filter((g) => g.label !== 'Unknown' && g.leads >= 10);
      const best = [...known].sort((a, b) => b.logins / b.leads - a.logins / a.leads)[0];
      return [
        best && leads ? {
          tone: 'good',
          headline: `${best.label} is your best source`,
          detail: `${pct(best.logins, best.leads)} of those leads reached login, against ${pct(logins, leads)} across all your leads.`,
        } : null,
        topSource && logins ? {
          tone: '',
          headline: `${pct(topSource.logins, logins)} of your logins came from ${topSource.label}`,
          detail: `${n(topSource.logins)} of ${n(logins)} logins in this period.`,
        } : null,
        shareInsight({
          part: unknown?.leads || 0, whole: leads,
          headline: (p) => `${p} of your leads have no source recorded`,
          detail: () => 'Add the source on those leads so your figures show what is really working.',
        }),
      ];
    }

    const byRm = rollup(rows.filter((r) => r.rm_id), (r) => r.rm_id, (r) => ({ label: r.rm_name }));
    const byBranch = rollup(rows.filter((r) => r.branch), (r) => r.branch, (r) => ({ label: r.branch }))
      .sort((a, b) => b.logins - a.logins);
    const people = (branch) => new Set(rows.filter((r) => r.branch === branch && r.rm_id).map((r) => r.rm_id)).size;
    const allPeople = new Set(rows.filter((r) => r.branch && r.rm_id).map((r) => r.rm_id)).size;
    const lead = byBranch[0];
    const referral = bySource.filter((g) => isReferral({ source_name: g.label }));
    const refLeads = referral.reduce((t, g) => t + g.leads, 0);
    const refLogins = referral.reduce((t, g) => t + g.logins, 0);

    return [
      topSource && logins ? {
        tone: topSource.logins / logins >= 0.7 ? 'warn' : '',
        headline: `${topSource.label} brings ${pct(topSource.logins, logins)} of logins`,
        detail: topSource.logins / logins >= 0.7
          ? 'The business rests on one source. Referrals and campaigns together are the hedge.'
          : `${n(topSource.logins)} of ${n(logins)} logins in this period.`,
      } : null,
      lead && byBranch.length > 1 && allPeople ? {
        tone: '',
        headline: `${lead.label} does ${pct(lead.logins, sum(byBranch, 'logins'))} of branch logins`,
        detail: `With ${pct(people(lead.label), allPeople)} of the people in a branch. ${byBranch.slice(1).map((b) => `${b.label}: ${pct(b.logins, b.leads)} lead→login`).join(' · ')} against ${pct(lead.logins, lead.leads)} in ${lead.label}.`,
      } : null,
      topNInsight(byRm, { value: (r) => r.logins, name: (r) => r.label, n: 5, plural: 'RMs', metric: 'logins' }),
      refLeads >= 10 && leads ? {
        tone: refLogins / refLeads > logins / leads ? 'good' : '',
        headline: `Referral leads reach login ${pct(refLogins, refLeads)} of the time`,
        detail: `Against ${pct(logins, leads)} overall, from ${n(refLeads)} referral leads.`,
      } : null,
      shareInsight({
        part: unknown?.leads || 0, whole: leads,
        headline: (p) => `${p} of leads in this period have no source`,
        detail: () => 'Every source above reads low by that much.',
      }),
    ];
  }

  function render() {
    const body = host.querySelector('[data-op-body]');
    body.innerHTML = `
      <div class="insights org-perf-insights" data-op-insights hidden></div>
      <div class="org-perf-sub"><div><h4>By source</h4><p>Ranked by logins. Share shows how much of the business each source carries.</p></div></div>
      ${sourceTable()}
      ${mine ? '' : branchTable()}`;

    renderInsights(body.querySelector('[data-op-insights]'), insights(), { max: 4 });
    body.querySelector('[data-op-source]')?.addEventListener('change', (e) => { state.source = e.target.value; render(); });
    body.querySelectorAll('[data-op-toggle]').forEach((tr) => tr.addEventListener('click', () => {
      const k = tr.dataset.opToggle;
      if (state.open.has(k)) state.open.delete(k); else state.open.add(k);
      render();
    }));
  }

  load();
  return { reload: load };
}
