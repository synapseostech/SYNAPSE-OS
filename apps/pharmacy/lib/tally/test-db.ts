/**
 * Test-only Supabase query-builder stand-in for the Tally route tests.
 *
 * Routes chain `.from().select().eq().eq().maybeSingle()` and
 * `.from().insert().select().single()`, then await the builder directly for
 * writes. This records each operation so a test can assert both the response
 * and what actually reached the database.
 */

export type FakeOperation = {
  table: string
  action: "select" | "insert" | "update" | "delete"
  payload?: unknown
  filters: Array<[string, unknown]>
  /** `gte` / `lte` bounds, kept apart from the equality filters. */
  bounds: Array<{ op: "gte" | "lte"; column: string; value: unknown }>
  /** The `.range(from, to)` window, when one was asked for. */
  window: { from: number; to: number } | null
  /** The arguments `.select()` was given, so a test can check the columns. */
  selected: unknown[]
}

export type FakeResult = { data?: unknown; error?: unknown; count?: number | null }

type Chain = {
  select: (...columns: unknown[]) => Chain
  insert: (payload: unknown) => Chain
  update: (payload: unknown) => Chain
  delete: () => Chain
  eq: (column: string, value: unknown) => Chain
  in: (column: string, values: unknown[]) => Chain
  is: (column: string, value: unknown) => Chain
  gte: (column: string, value: unknown) => Chain
  lte: (column: string, value: unknown) => Chain
  order: (column: string, options?: { ascending?: boolean }) => Chain
  range: (from: number, to: number) => Chain
  limit: (count: number) => Chain
  maybeSingle: () => Promise<FakeResult>
  single: () => Promise<FakeResult>
  then: (
    onFulfilled?: (value: FakeResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>
}

export function fakeSupabase(resolve: (operation: FakeOperation) => FakeResult) {
  const operations: FakeOperation[] = []

  const from = (table: string): Chain => {
    const operation: FakeOperation = {
      table,
      action: "select",
      filters: [],
      bounds: [],
      window: null,
      selected: [],
    }
    operations.push(operation)

    const chain: Chain = {
      select: (...columns) => {
        operation.selected = columns
        return chain
      },
      insert: (payload) => {
        operation.action = "insert"
        operation.payload = payload
        return chain
      },
      update: (payload) => {
        operation.action = "update"
        operation.payload = payload
        return chain
      },
      delete: () => {
        operation.action = "delete"
        return chain
      },
      eq: (column, value) => {
        operation.filters.push([column, value])
        return chain
      },
      in: (column, values) => {
        operation.filters.push([column, values])
        return chain
      },
      is: (column, value) => {
        operation.filters.push([column, value])
        return chain
      },
      gte: (column, value) => {
        operation.bounds.push({ op: "gte", column, value })
        return chain
      },
      lte: (column, value) => {
        operation.bounds.push({ op: "lte", column, value })
        return chain
      },
      order: () => chain,
      range: (from, to) => {
        operation.window = { from, to }
        return chain
      },
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resolve(operation)),
      single: () => Promise.resolve(resolve(operation)),
      then: (onFulfilled, onRejected) =>
        Promise.resolve(resolve(operation)).then(onFulfilled, onRejected),
    }

    return chain
  }

  return {
    client: {
      from,
      storage: {
        from: () => ({
          remove: () => Promise.resolve({ data: null, error: null }),
        }),
      },
    },
    operations,
  }
}

/** The filters a route applied, as a plain object a test can compare. */
export function filtersOf(operation: FakeOperation): Record<string, unknown> {
  return Object.fromEntries(operation.filters)
}

/** The date bounds a route applied, keyed by column. */
export function boundsOf(
  operation: FakeOperation,
): Record<string, { gte?: unknown; lte?: unknown }> {
  const result: Record<string, { gte?: unknown; lte?: unknown }> = {}
  for (const bound of operation.bounds) {
    result[bound.column] = { ...result[bound.column], [bound.op]: bound.value }
  }
  return result
}
