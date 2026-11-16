/**
 * Read every row a PostgREST query matches.
 *
 * PostgREST answers an un-ranged read with at most its `max-rows` (1,000 on
 * Supabase) and no error, so a report that sums an un-ranged read silently
 * stops at the first thousand rows. This pages with `.range()` until a short
 * page arrives.
 *
 * `build` must return a fresh query each call: a Supabase builder is consumed
 * when it is awaited. A tie-break order on `id` is appended so rows sharing
 * the caller's sort value cannot move between pages.
 */

export const READ_ALL_PAGE_SIZE = 1000
/** Upper bound so a runaway read fails loudly instead of exhausting memory. */
export const READ_ALL_MAX_ROWS = 250_000

type PagedResult = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>

export async function readAllRows<T>(
  build: () => any,
  options: {
    pageSize?: number
    maxRows?: number
    tieBreak?: string | null
    /** Read at most this many rows and stop without error: a "first N" list. */
    limit?: number
  } = {},
): Promise<{ data: T[]; error: { message: string } | null }> {
  const pageSize = options.pageSize ?? READ_ALL_PAGE_SIZE
  const maxRows = options.maxRows ?? READ_ALL_MAX_ROWS
  const tieBreak = options.tieBreak === undefined ? "id" : options.tieBreak
  const limit = options.limit
  const rows: T[] = []

  for (let from = 0; from < maxRows; from += pageSize) {
    const size = limit === undefined ? pageSize : Math.min(pageSize, limit - from)
    if (size <= 0) return { data: rows, error: null }
    let query = build()
    if (tieBreak) query = query.order(tieBreak, { ascending: true })
    const { data, error } = await (query.range(from, from + size - 1) as PagedResult)
    if (error) return { data: rows, error }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < size) return { data: rows, error: null }
    if (limit !== undefined && rows.length >= limit) return { data: rows.slice(0, limit), error: null }
  }
  return {
    data: rows,
    error: { message: `READ_ALL_LIMIT: more than ${maxRows.toLocaleString("en-GB")} rows matched; narrow the period` },
  }
}
