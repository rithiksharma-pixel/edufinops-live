// =========================================================
// SHARED — paginated fetch
//
// PostgREST caps every response at 1000 rows (Supabase's default
// db-max-rows). Any query that feeds a COUNT, a SUM or a "show me
// everything" list silently truncated at 1000 and reported wrong
// numbers — e.g. a 1,444-lead pipeline rendering as 1,000.
//
// `fetchAll` walks the result set with .range() until a short page
// comes back, so callers get every row they're entitled to (RLS still
// decides what that is — this changes nothing about permissions).
//
// IMPORTANT: keyset order matters. Postgres gives no stable row order
// without ORDER BY, so paging an unordered query can repeat or skip
// rows between pages. Every caller must supply a deterministic order;
// `orderBy` appends a unique tiebreaker column (default `id`) so an
// order on a non-unique column (created_at, name) is still total.
// =========================================================

const PAGE_SIZE = 1000;

/**
 * @param {() => object} buildQuery  Returns a FRESH Supabase query builder
 *   each call (builders are single-use — reusing one across pages throws).
 * @param {object}   [opts]
 * @param {string}   [opts.tiebreak='id']  Unique column appended to ORDER BY.
 * @param {boolean}  [opts.ascending=true] Direction for the tiebreaker.
 * @param {number}   [opts.pageSize=1000]
 * @returns {Promise<object[]>} every matching row
 */
/**
 * Same as fetchAll, but resolves to Supabase's `{ data, error }` shape
 * instead of throwing. Lets an existing
 *   `const { data, error } = await supabase.from(...)...`
 * call site be made paging-safe by wrapping it, with no change to the
 * `if (error) throw error` handling that follows.
 */
export async function fetchAllResult(buildQuery, opts) {
  try {
    return { data: await fetchAll(buildQuery, opts), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

export async function fetchAll(buildQuery, { tiebreak = 'id', ascending = true, pageSize = PAGE_SIZE } = {}) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = buildQuery().range(from, from + pageSize - 1);
    if (tiebreak) query = query.order(tiebreak, { ascending });

    const { data, error } = await query;
    if (error) throw error;

    rows.push(...data);
    // A short page means we've reached the end. An exactly-full last page
    // costs one extra empty request, which is correct and cheap.
    if (data.length < pageSize) return rows;
  }
}
