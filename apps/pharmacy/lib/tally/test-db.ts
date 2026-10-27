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
}

export type FakeResult = { data?: unknown; error?: unknown }

type Chain = {
  select: (...columns: unknown[]) => Chain
  insert: (payload: unknown) => Chain
  update: (payload: unknown) => Chain
  delete: () => Chain
  eq: (column: string, value: unknown) => Chain
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
    const operation: FakeOperation = { table, action: "select", filters: [] }
    operations.push(operation)

    const chain: Chain = {
      select: () => chain,
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
      maybeSingle: () => Promise.resolve(resolve(operation)),
      single: () => Promise.resolve(resolve(operation)),
      then: (onFulfilled, onRejected) =>
        Promise.resolve(resolve(operation)).then(onFulfilled, onRejected),
    }

    return chain
  }

  return { client: { from }, operations }
}

/** The filters a route applied, as a plain object a test can compare. */
export function filtersOf(operation: FakeOperation): Record<string, unknown> {
  return Object.fromEntries(operation.filters)
}
