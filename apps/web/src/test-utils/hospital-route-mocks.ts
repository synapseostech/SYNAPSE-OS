/**
 * Test helpers for hospital route tests: a thenable PostgREST query recorder
 * and a staff context factory. Each `.from(table)` call returns a builder that
 * records every filter and resolves to the result registered for that table.
 */
export type QueryCall = { table: string; ops: Array<[string, unknown[]]> }

export type QueryResult = { data: unknown; error: { code?: string; message: string } | null }

export function createDbMock(results: Record<string, QueryResult | QueryResult[]>) {
  const calls: QueryCall[] = []
  const queues = new Map<string, QueryResult[]>()
  for (const [table, value] of Object.entries(results)) {
    queues.set(table, Array.isArray(value) ? [...value] : [value])
  }
  const next = (table: string): QueryResult => {
    const queue = queues.get(table)
    if (!queue || queue.length === 0) return { data: null, error: null }
    return (queue.length > 1 ? queue.shift() : queue[0]) as QueryResult
  }

  const from = (table: string) => {
    const call: QueryCall = { table, ops: [] }
    calls.push(call)
    const result = next(table)
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'neq', 'in', 'is', 'gt', 'lt', 'gte', 'lte', 'ilike', 'or', 'order', 'limit', 'update', 'insert']) {
      builder[op] = (...args: unknown[]) => {
        call.ops.push([op, args])
        return builder
      }
    }
    builder.maybeSingle = () => {
      call.ops.push(['maybeSingle', []])
      return Promise.resolve(result)
    }
    builder.single = builder.maybeSingle
    builder.then = (resolve: (value: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
    return builder
  }

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const rpcResults = new Map<string, QueryResult>()
  const rpc = (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    return Promise.resolve(rpcResults.get(fn) ?? { data: null, error: null })
  }

  return {
    from,
    rpc,
    calls,
    rpcCalls,
    setRpc(fn: string, result: QueryResult) {
      rpcResults.set(fn, result)
    },
    /** All `.eq(column, value)` filters applied to a table, in call order. */
    eqs(table: string): Array<[string, unknown]> {
      return calls
        .filter((c) => c.table === table)
        .flatMap((c) => c.ops.filter(([op]) => op === 'eq').map(([, args]) => [args[0] as string, args[1]] as [string, unknown]))
    },
  }
}

export const TENANT_A = '0edb651a-232a-4289-9b3d-ae5bb1bac2cb'
export const TENANT_B = '200dfeb5-4c09-4a5d-8d46-14aa4b78a6ec'
export const HOSPITAL_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
export const USER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

export function staff(role: string, tenantId = TENANT_A) {
  return {
    userId: USER,
    email: `${role}@example.test`,
    role,
    tenantId,
    hospitalId: HOSPITAL_A,
    facilityType: 'hospital',
    fullName: role,
  }
}

export const MISSING_RPC = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
