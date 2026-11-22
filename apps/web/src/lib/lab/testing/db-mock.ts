/**
 * Minimal Supabase client double for lab tests: records every builder call
 * and resolves to a canned { data, error }. Not shipped (imported by tests only).
 */
import { vi } from 'vitest'

export type Call = { method: string; args: unknown[] }
export type Result = { data?: unknown; error?: { message?: string; code?: string } | null; count?: number | null }

export function queryMock(result: Result | (() => Result) = { data: null, error: null }) {
  const calls: Call[] = []
  const resolve = () => {
    const r = typeof result === 'function' ? result() : result
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }
  }
  const builder: Record<string, unknown> = {}
  const chain = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'or', 'lt', 'gt', 'lte', 'gte', 'ilike', 'contains', 'order', 'limit', 'range']
  for (const method of chain) {
    builder[method] = vi.fn((...args: unknown[]) => { calls.push({ method, args }); return builder })
  }
  builder.maybeSingle = vi.fn(async () => { calls.push({ method: 'maybeSingle', args: [] }); return resolve() })
  builder.single = vi.fn(async () => { calls.push({ method: 'single', args: [] }); return resolve() })
  builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(resolve()).then(onFulfilled, onRejected)
  return { builder, calls }
}

export function dbMock(options: {
  rpc?: (fn: string, args: Record<string, unknown>) => Result | Promise<Result>
  tables?: Record<string, Result | (() => Result)>
} = {}) {
  const tableCalls: Record<string, Call[][]> = {}
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    const r = options.rpc ? await options.rpc(fn, args) : { data: null }
    return { data: r.data ?? null, error: r.error ?? null }
  })
  const from = vi.fn((table: string) => {
    const q = queryMock(options.tables?.[table] ?? { data: null })
    ;(tableCalls[table] ??= []).push(q.calls)
    return q.builder
  })
  return { db: { rpc, from }, rpc, from, tableCalls }
}

export function callsOf(calls: Call[] | undefined, method: string): unknown[][] {
  return (calls ?? []).filter((c) => c.method === method).map((c) => c.args)
}
