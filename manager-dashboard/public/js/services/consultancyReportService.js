// =========================================================
// SERVICE LAYER — Consultancy reporting
//
// Both RPCs run SECURITY INVOKER, so RLS decides what the caller sees:
// an Admin gets every consultancy, a Manager gets whatever their role can
// read. There is deliberately no role handling in this file — the database
// is the scoping boundary, same as milestoneService.
// =========================================================
import { supabase } from '../config/supabaseClient.js';

/**
 * One row per consultancy for the given window (null = all time).
 * @returns {Promise<Array>} ordered by total_leads desc, as the RPC returns it
 */
export async function getConsultancyReport(from = null, to = null) {
  const { data, error } = await supabase.rpc('consultancy_report', {
    p_from: from || null,
    p_to: to || null,
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * The leads behind one report row. A consultancy that exists as a proper
 * record is identified by id; one that only ever appeared as free text in
 * `consultancy_other_name` has no id, so it is matched by name instead —
 * which is why both arguments exist and exactly one is populated.
 */
export async function getConsultancyLeads(row, from = null, to = null) {
  const { data, error } = await supabase.rpc('consultancy_lead_detail', {
    p_consultancy_id: row.consultancy_id || null,
    p_consultancy_name: row.consultancy_id ? null : row.consultancy_name,
    p_from: from || null,
    p_to: to || null,
  });
  if (error) throw error;
  return data ?? [];
}

/**
 * Conversion percentages between funnel steps.
 *
 * Each rate is against the step above it, not against total leads — "of the
 * ones that reached Login, how many got sanctioned" is the question a
 * consultancy actually asks. Guarded against divide-by-zero, which is common
 * here because most consultancies have no disbursements yet.
 */
export function conversionRates(r) {
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  return {
    leadToLogin: pct(r.login, r.total_leads),
    loginToSanction: pct(r.sanction, r.login),
    sanctionToPf: pct(r.pf_paid, r.sanction),
    pfToDisbursement: pct(r.disbursement, r.pf_paid),
    leadToDisbursement: pct(r.disbursement, r.total_leads),
  };
}

/** Rows -> CSV text. Values are quoted and internal quotes doubled, so a
 *  consultancy name containing a comma cannot shift every later column. */
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(',')).join('\n');
  return `${head}\n${body}`;
}
