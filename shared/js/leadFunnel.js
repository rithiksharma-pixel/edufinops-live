// =========================================================
// SHARED — lead funnel: how far each lead got, not where it sits now
//
// Stage tables used to count leads at their CURRENT stage, so "Login" meant
// "sitting at Login today" and left out everyone who logged in and moved on.
// A funnel counts a lead at every stage it reached, so each stage includes
// all the later ones and each step's rate is meaningful.
//
// Reached = the furthest of:
//   * the lead's current stage, unless it is Lead Lost (sequence 900, an
//     exit rather than a step past Disbursement — never read it as progress);
//   * its milestone dates: login_date → Login, sanction_date → Sanction,
//     pf_date → PF Paid, disbursed_date → Disbursement.
// So a lead lost after logging in still counts toward Login — it got there.
// =========================================================

export const LEAD_JOURNEY = [
  { name: 'Lead Qualified', order: 10 },
  { name: 'App Start', order: 20 },
  { name: 'Bank Prospect', order: 30 },
  { name: 'Login', order: 40 },
  { name: 'Sanction', order: 50 },
  { name: 'PF Paid', order: 60 },
  { name: 'Disbursement', order: 70 },
];

const LOST = 'Lead Lost';

/**
 * @param {object} l  needs stage name + order (either lead_stages{name,sequence_order}
 *   or stage_name/stage_order), lost_reason_id or is_lost, and any milestone
 *   dates it has (login_date, sanction_date, pf_date, disbursed_date).
 * @returns {number} the sequence order of the furthest stage reached (10 at least)
 */
export function reachedOrder(l) {
  const name = l.lead_stages?.name ?? l.stage_name;
  const order = l.lead_stages?.sequence_order ?? l.stage_order ?? 10;
  const lost = name === LOST || Boolean(l.lost_reason_id) || Boolean(l.is_lost);
  return Math.max(
    lost ? 10 : Math.min(order, 70),
    l.disbursed_date ? 70 : 0,
    l.pf_date ? 60 : 0,
    l.sanction_date ? 50 : 0,
    l.login_date ? 40 : 0,
    10,
  );
}

/** [{ name, order, count, rate }] — rate is the share of the stage before. */
export function leadFunnel(leads) {
  const reached = leads.map(reachedOrder);
  let previous = null;
  return LEAD_JOURNEY.map((s) => {
    const count = reached.filter((r) => r >= s.order).length;
    const rate = previous ? count / previous : null;
    previous = count;
    return { ...s, count, rate };
  });
}

/**
 * Funnel rows in the page-kit style: stage, bar, count, and the step rate.
 * Bars are scaled to the first stage, so they narrow as the funnel does.
 */
export function leadFunnelRowsHtml(funnel, escapeHtml) {
  const top = Math.max(1, funnel[0]?.count || 0);
  return funnel.map((s) => `
    <div class="pp-funnel-row">
      <span>${escapeHtml(s.name)}</span>
      <span class="pp-funnel-track"><span class="pp-funnel-fill" style="width:${s.count ? Math.max(2, (s.count / top) * 100) : 0}%"></span></span>
      <span class="pp-num">${s.count.toLocaleString('en-IN')}${s.rate != null ? `<small class="pp-rate">${Math.round(s.rate * 100)}%</small>` : ''}</span>
    </div>`).join('');
}
