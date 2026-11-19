import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * In-memory stand-in for the supabase-js query builder: enough of select / eq /
 * in / gte / order / range / limit / maybeSingle / single / insert / update /
 * upsert / delete / rpc for the stock-take routes, with the one-open-take
 * unique index and PostgREST's 1,000-row page cap.
 */
const { state, requireMobilePharmacyAuth } = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const state = {
    tables: {} as Record<string, Row[]>,
    rpcCalls: [] as Array<{ name: string; args: Row }>,
    rpcResult: { data: null as unknown, error: null as unknown },
    seq: 0,
  }
  return { state, requireMobilePharmacyAuth: vi.fn() }
})

vi.mock('@synapse/db/admin', () => {
  type Row = Record<string, unknown>
  const PAGE_CAP = 1000

  function table(name: string): Row[] {
    state.tables[name] ??= []
    return state.tables[name]
  }

  function builder(name: string) {
    const filters: Array<(row: Row) => boolean> = []
    const orders: Array<{ column: string; ascending: boolean }> = []
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let payload: Row | Row[] | null = null
    let onConflict: string[] = []
    let head = false
    let countMode = false
    let rangeFrom = 0
    let rangeTo: number | null = null
    let limitN: number | null = null
    let returning = false

    const api: Record<string, unknown> = {}
    api.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (op !== 'select') returning = true
      if (opts?.head) head = true
      if (opts?.count) countMode = true
      return api
    }
    api.eq = (column: string, value: unknown) => {
      filters.push((row) => row[column] === value)
      return api
    }
    api.in = (column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]))
      return api
    }
    api.gte = (column: string, value: string) => {
      filters.push((row) => String(row[column]) >= value)
      return api
    }
    api.order = (column: string, opts?: { ascending?: boolean }) => {
      orders.push({ column, ascending: opts?.ascending !== false })
      return api
    }
    api.range = (from: number, to: number) => {
      rangeFrom = from
      rangeTo = to
      return api
    }
    api.limit = (n: number) => {
      limitN = n
      return api
    }
    api.insert = (rows: Row | Row[]) => {
      op = 'insert'
      payload = rows
      return api
    }
    api.update = (patch: Row) => {
      op = 'update'
      payload = patch
      return api
    }
    api.upsert = (rows: Row | Row[], opts?: { onConflict?: string }) => {
      op = 'upsert'
      payload = rows
      onConflict = (opts?.onConflict ?? 'id').split(',')
      return api
    }
    api.delete = () => {
      op = 'delete'
      return api
    }

    function matched(): Row[] {
      let rows = table(name).filter((row) => filters.every((f) => f(row)))
      for (const { column, ascending } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = String(a[column] ?? '')
          const y = String(b[column] ?? '')
          return ascending ? x.localeCompare(y) : y.localeCompare(x)
        })
      }
      return rows
    }

    function withId(row: Row): Row {
      state.seq += 1
      return {
        id: row.id ?? `00000000-0000-4000-8000-${String(state.seq).padStart(12, '0')}`,
        opened_at: name === 'pharmacy_stock_takes' ? new Date().toISOString() : undefined,
        ...row,
      }
    }

    function violatesOpenIndex(row: Row): boolean {
      if (name !== 'pharmacy_stock_takes') return false
      if (row.status !== 'counting' && row.status !== 'review') return false
      return table(name).some(
        (other) =>
          other !== row &&
          other.tenant_id === row.tenant_id &&
          (other.status === 'counting' || other.status === 'review'),
      )
    }

    function execute(): { data: unknown; error: unknown; count?: number } {
      if (op === 'select') {
        const rows = matched()
        if (head) return { data: null, error: null, count: rows.length }
        let page = rows.slice(rangeFrom, rangeTo === null ? undefined : rangeTo + 1)
        if (limitN !== null) page = page.slice(0, limitN)
        page = page.slice(0, PAGE_CAP)
        return { data: page, error: null, count: countMode ? rows.length : undefined }
      }
      if (op === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => withId(r as Row))
        for (const row of rows) {
          if (violatesOpenIndex(row)) return { data: null, error: { code: '23505', message: 'duplicate' } }
        }
        table(name).push(...rows)
        return { data: rows, error: null }
      }
      if (op === 'update') {
        const rows = matched()
        for (const row of rows) Object.assign(row, payload)
        return { data: rows, error: null }
      }
      if (op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload as Row]
        const out: Row[] = []
        for (const incoming of rows) {
          const existing = table(name).find((row) => onConflict.every((c) => row[c] === incoming[c]))
          if (existing) {
            Object.assign(existing, incoming)
            out.push(existing)
          } else {
            const created = withId(incoming)
            table(name).push(created)
            out.push(created)
          }
        }
        return { data: out, error: null }
      }
      const doomed = new Set(matched())
      state.tables[name] = table(name).filter((row) => !doomed.has(row))
      return { data: [...doomed], error: null }
    }

    api.maybeSingle = async () => {
      const result = execute()
      const rows = (Array.isArray(result.data) ? result.data : []) as Row[]
      return { data: rows[0] ?? null, error: result.error }
    }
    api.single = async () => {
      const result = execute()
      if (result.error) return { data: null, error: result.error }
      const rows = (Array.isArray(result.data) ? result.data : []) as Row[]
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'not one row' } }
    }
    api.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      try {
        const result = execute()
        return Promise.resolve(returning ? result : result).then(resolve, reject)
      } catch (error) {
        return Promise.reject(error).then(resolve, reject)
      }
    }
    return api
  }

  return {
    supabaseAdmin: {
      from: (name: string) => builder(name),
      rpc: async (name: string, args: Row) => {
        state.rpcCalls.push({ name, args })
        return state.rpcResult
      },
    },
  }
})

vi.mock('../../../../../lib/mobile-pharmacy-auth', () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (value: unknown) =>
    !(value instanceof NextResponse) && Boolean(value) && typeof value === 'object' && 'userId' in (value as object),
  mobileHasPharmacyCapability: (auth: { role: string }, capability: string) => {
    if (auth.role === 'pharmacy_cashier') return capability === 'inventory.read'
    if (auth.role === 'pharmacist') {
      return ['inventory.read', 'inventory.write', 'inventory.adjust'].includes(capability)
    }
    return false
  },
}))

import { GET as listTakes, POST as openTake } from './route'
import { GET as getTake, PATCH as patchTake } from './[id]/route'
import { GET as getItems } from './[id]/items/route'
import { POST as postCounts } from './[id]/counts/route'
import { GET as getReview, PUT as putOverride } from './[id]/review/route'
import { POST as postTake } from './[id]/post/route'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const MANAGER = 'aaaaaaaa-0000-4000-8000-00000000aa01'
const COUNTER = 'aaaaaaaa-0000-4000-8000-00000000aa02'
const P_NEG = 'aaaaaaaa-0000-4000-8000-0000000000f1'
const P_TWO = 'aaaaaaaa-0000-4000-8000-0000000000f2'
const P_OTHER_TENANT = 'bbbbbbbb-0000-4000-8000-0000000000f1'
const B_NEG = 'aaaaaaaa-0000-4000-8000-0000000001a1'
const B1 = 'aaaaaaaa-0000-4000-8000-0000000002b1'
const B2 = 'aaaaaaaa-0000-4000-8000-0000000002b2'

function as(role: 'pharmacist' | 'pharmacy_cashier', userId = role === 'pharmacist' ? MANAGER : COUNTER, tenantId = TENANT_A) {
  requireMobilePharmacyAuth.mockResolvedValue({ userId, tenantId, role, token: 't' })
}

function req(method: string, path: string, body?: unknown) {
  return new NextRequest(`https://app.test/api/mobile/pharmacy/stock-takes${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function seed() {
  state.tables = {
    pharmacy_products: [
      { id: P_NEG, tenant_id: TENANT_A, name: 'Amoxicillin 500mg', sku: 'AMX', barcode: '600100', category: 'Antibiotics', quantity: -5, cost_price: 100, is_active: true, unit_of_measure: 'Capsule', updated_at: '2026-11-18T08:00:00Z' },
      { id: P_TWO, tenant_id: TENANT_A, name: 'Paracetamol 500mg', sku: 'PARA', barcode: '600200', category: 'Analgesics', quantity: 30, cost_price: 50, is_active: true, unit_of_measure: 'Tablet', updated_at: '2026-11-18T08:00:00Z' },
      { id: P_OTHER_TENANT, tenant_id: TENANT_B, name: 'Tenant B secret', sku: 'B', barcode: '999', category: 'Analgesics', quantity: 9, cost_price: 10, is_active: true, unit_of_measure: 'Tablet', updated_at: '2026-11-18T08:00:00Z' },
    ],
    pharmacy_product_batches: [
      { id: B_NEG, tenant_id: TENANT_A, product_id: P_NEG, batch_number: 'NEG-STOCK', quantity: -5, expiry_date: '2099-12-31', status: 'active', cost_price: 100 },
      { id: B1, tenant_id: TENANT_A, product_id: P_TWO, batch_number: 'B1', quantity: 10, expiry_date: '2027-06-30', status: 'active', cost_price: 50 },
      { id: B2, tenant_id: TENANT_A, product_id: P_TWO, batch_number: 'B2', quantity: 20, expiry_date: '2028-06-30', status: 'active', cost_price: 60 },
    ],
    profiles: [
      { id: MANAGER, full_name: 'Grace Manager' },
      { id: COUNTER, full_name: 'Joel Counter' },
    ],
  }
  state.rpcCalls = []
  state.rpcResult = { data: null, error: null }
}

async function openCount(body: Record<string, unknown> = {}) {
  as('pharmacist')
  const res = await openTake(req('POST', '', { scope: 'all', ...body }))
  const json = await res.json()
  return { res, json, id: json.stockTake?.id as string }
}

function entry(overrides: Record<string, unknown>) {
  return {
    entryId: crypto.randomUUID(),
    productId: P_TWO,
    batchId: null,
    countedQty: 1,
    countedAt: '2026-11-18T09:00:00.000Z',
    ...overrides,
  }
}

describe('mobile stock takes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  describe('opening', () => {
    it('refuses an unauthenticated caller', async () => {
      requireMobilePharmacyAuth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
      const res = await listTakes(req('GET', ''))
      expect(res.status).toBe(401)
    })

    it('lets only a manager open a count', async () => {
      as('pharmacy_cashier')
      const res = await openTake(req('POST', '', { scope: 'all' }))
      expect(res.status).toBe(403)
      expect(state.tables.pharmacy_stock_takes ?? []).toHaveLength(0)
    })

    it('opens a blind whole-store count and audits it', async () => {
      const { res, json } = await openCount()
      expect(res.status).toBe(201)
      expect(json.stockTake).toMatchObject({ status: 'counting', scope: 'all', blind: true, canManage: true })
      expect(json.stockTake.reference).toMatch(/^ST-\d{8}-01$/)
      expect(state.tables.pharmacy_audit_logs?.[0]).toMatchObject({ action: 'stock_take.open', tenant_id: TENANT_A })
    })

    it('refuses a second open count for the same pharmacy', async () => {
      await openCount()
      const second = await openCount()
      expect(second.res.status).toBe(409)
      expect(second.json.code).toBe('STOCK_TAKE_ALREADY_OPEN')
    })

    it('requires categories for a category count', async () => {
      as('pharmacist')
      const res = await openTake(req('POST', '', { scope: 'category', categories: [] }))
      expect(res.status).toBe(400)
    })

    it('lists the open count for a counter without manager rights', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      const res = await listTakes(req('GET', ''))
      const json = await res.json()
      expect(json.open.id).toBe(id)
      expect(json.open.showBook).toBe(false)
      expect(json.canManage).toBe(false)
    })
  })

  describe('count sheet', () => {
    it('hides book quantities from counters on a blind count and drops the overdraft batch', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      const res = await getItems(req('GET', `/${id}/items`), params(id))
      const json = await res.json()
      expect(res.status).toBe(200)
      const neg = json.items.find((i: { id: string }) => i.id === P_NEG)
      expect(neg.bookQty).toBeUndefined()
      expect(neg.batches).toEqual([])
      const two = json.items.find((i: { id: string }) => i.id === P_TWO)
      expect(two.batches.map((b: { batchNumber: string }) => b.batchNumber).sort()).toEqual(['B1', 'B2'])
      expect(two.batches[0].bookQty).toBeUndefined()
      expect(json.items.find((i: { id: string }) => i.id === P_OTHER_TENANT)).toBeUndefined()
    })

    it('shows book quantities to the manager', async () => {
      const { id } = await openCount()
      const res = await getItems(req('GET', `/${id}/items`), params(id))
      const json = await res.json()
      const neg = json.items.find((i: { id: string }) => i.id === P_NEG)
      expect(neg).toMatchObject({ bookQty: -5, negativeBook: true })
    })

    it('limits a category count to its categories', async () => {
      const { id } = await openCount({ scope: 'category', categories: ['Antibiotics'] })
      const json = await (await getItems(req('GET', `/${id}/items`), params(id))).json()
      expect(json.items.map((i: { id: string }) => i.id)).toEqual([P_NEG])
    })

    it('returns every product of a large catalogue, past the 1,000-row page cap', async () => {
      for (let i = 0; i < 2025; i++) {
        state.tables.pharmacy_products.push({
          id: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
          tenant_id: TENANT_A,
          name: `Item ${String(i).padStart(4, '0')}`,
          category: 'General',
          quantity: 1,
          cost_price: 1,
          is_active: true,
        })
      }
      const { id } = await openCount()
      const json = await (await getItems(req('GET', `/${id}/items`), params(id))).json()
      expect(json.items).toHaveLength(2027)
    })

    it('does not reveal another pharmacy’s stock take', async () => {
      const { id } = await openCount()
      as('pharmacist', 'bbbbbbbb-0000-4000-8000-00000000bb01', TENANT_B)
      const res = await getItems(req('GET', `/${id}/items`), params(id))
      expect(res.status).toBe(404)
    })
  })

  describe('uploading counts', () => {
    it('saves counts per counter and replays the same entry without duplicating it', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      const e = entry({ batchId: B1, countedQty: 8 })
      const first = await (await postCounts(req('POST', `/${id}/counts`, { deviceId: 'phone-1', entries: [e] }), params(id))).json()
      expect(first.results).toEqual([{ entryId: e.entryId, outcome: 'saved' }])
      const again = await (await postCounts(req('POST', `/${id}/counts`, { entries: [e] }), params(id))).json()
      expect(again.results[0].outcome).toBe('saved')
      expect(state.tables.pharmacy_stock_take_counts).toHaveLength(1)
      expect(state.tables.pharmacy_stock_take_counts[0]).toMatchObject({
        batch_key: B1,
        counted_qty: 8,
        counted_by: COUNTER,
        device_id: 'phone-1',
        tenant_id: TENANT_A,
      })
    })

    it('keeps the newer count when an older one arrives late from an offline phone', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      const newer = entry({ batchId: B1, countedQty: 9, countedAt: '2026-11-18T10:00:00.000Z' })
      const older = entry({ batchId: B1, countedQty: 3, countedAt: '2026-11-18T09:00:00.000Z' })
      await postCounts(req('POST', `/${id}/counts`, { entries: [newer] }), params(id))
      const json = await (await postCounts(req('POST', `/${id}/counts`, { entries: [older] }), params(id))).json()
      expect(json.results[0].outcome).toBe('stale')
      expect(state.tables.pharmacy_stock_take_counts[0].counted_qty).toBe(9)
    })

    it('keeps one row per person: two counters on one batch are two rows', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      await postCounts(req('POST', `/${id}/counts`, { entries: [entry({ batchId: B1, countedQty: 8 })] }), params(id))
      as('pharmacist')
      await postCounts(req('POST', `/${id}/counts`, { entries: [entry({ batchId: B1, countedQty: 2 })] }), params(id))
      expect(state.tables.pharmacy_stock_take_counts).toHaveLength(2)
    })

    it('clears a count when the phone sends a null quantity', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      await postCounts(req('POST', `/${id}/counts`, { entries: [entry({ countedQty: 4 })] }), params(id))
      const clear = entry({ countedQty: null, countedAt: '2026-11-18T11:00:00.000Z' })
      const json = await (await postCounts(req('POST', `/${id}/counts`, { entries: [clear] }), params(id))).json()
      expect(json.results[0].outcome).toBe('cleared')
      expect(state.tables.pharmacy_stock_take_counts).toHaveLength(0)
    })

    it('rejects bad entries one by one and keeps the good ones', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      const good = entry({ countedQty: 5 })
      const negative = entry({ countedQty: -1 })
      const foreign = entry({ productId: P_OTHER_TENANT })
      const wrongBatch = entry({ productId: P_NEG, batchId: B1 })
      const noExpiry = entry({ newBatchNumber: 'X9', countedQty: 2 })
      const json = await (
        await postCounts(
          req('POST', `/${id}/counts`, { entries: [good, negative, foreign, wrongBatch, noExpiry] }),
          params(id),
        )
      ).json()
      const byId = Object.fromEntries(json.results.map((r: { entryId: string; outcome: string }) => [r.entryId, r.outcome]))
      expect(byId[good.entryId]).toBe('saved')
      expect(byId[negative.entryId]).toBe('rejected')
      expect(byId[foreign.entryId]).toBe('rejected')
      expect(byId[wrongBatch.entryId]).toBe('rejected')
      expect(byId[noExpiry.entryId]).toBe('rejected')
      expect(state.tables.pharmacy_stock_take_counts).toHaveLength(1)
    })

    it('stores a batch found on the shelf under a new: key', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      await postCounts(
        req('POST', `/${id}/counts`, {
          entries: [entry({ newBatchNumber: ' lot 77 ', newExpiryDate: '2028-03-31', countedQty: 6 })],
        }),
        params(id),
      )
      expect(state.tables.pharmacy_stock_take_counts[0]).toMatchObject({
        batch_key: 'new:LOT 77',
        new_batch_number: 'LOT 77',
        new_expiry_date: '2028-03-31',
        batch_id: null,
      })
    })

    it('refuses counts once counting has closed', async () => {
      const { id } = await openCount()
      await patchTake(req('PATCH', `/${id}`, { action: 'close' }), params(id))
      as('pharmacy_cashier')
      const res = await postCounts(req('POST', `/${id}/counts`, { entries: [entry({})] }), params(id))
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('STOCK_TAKE_CLOSED')
    })
  })

  describe('session control', () => {
    it('lets only a manager close, reopen or cancel', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      expect((await patchTake(req('PATCH', `/${id}`, { action: 'close' }), params(id))).status).toBe(403)
      as('pharmacist')
      const closed = await (await patchTake(req('PATCH', `/${id}`, { action: 'close' }), params(id))).json()
      expect(closed.stockTake.status).toBe('review')
      const reopened = await (await patchTake(req('PATCH', `/${id}`, { action: 'reopen' }), params(id))).json()
      expect(reopened.stockTake.status).toBe('counting')
      const cancelled = await (await patchTake(req('PATCH', `/${id}`, { action: 'cancel' }), params(id))).json()
      expect(cancelled.stockTake.status).toBe('cancelled')
      expect((await patchTake(req('PATCH', `/${id}`, { action: 'reopen' }), params(id))).status).toBe(409)
    })

    it('reports progress per counter', async () => {
      const { id } = await openCount()
      as('pharmacy_cashier')
      await postCounts(req('POST', `/${id}/counts`, { entries: [entry({ countedQty: 3 })] }), params(id))
      const json = await (await getTake(req('GET', `/${id}`), params(id))).json()
      expect(json.progress).toMatchObject({ productsCounted: 1, myProductsCounted: 1 })
    })
  })

  describe('review and posting', () => {
    async function countedTake() {
      const { id } = await openCount()
      as('pharmacy_cashier')
      await postCounts(
        req('POST', `/${id}/counts`, {
          entries: [
            entry({ productId: P_NEG, countedQty: 10 }),
            entry({ batchId: B1, countedQty: 8 }),
            entry({ countedQty: 15 }),
          ],
        }),
        params(id),
      )
      as('pharmacist')
      await postCounts(req('POST', `/${id}/counts`, { entries: [entry({ batchId: B1, countedQty: 2 })] }), params(id))
      return id
    }

    it('is for managers only', async () => {
      const id = await countedTake()
      as('pharmacy_cashier')
      expect((await getReview(req('GET', `/${id}/review`), params(id))).status).toBe(403)
      expect((await postTake(req('POST', `/${id}/post`), params(id))).status).toBe(403)
    })

    it('shows book against counted with variance and value, negatives brought back', async () => {
      const id = await countedTake()
      const json = await (await getReview(req('GET', `/${id}/review`), params(id))).json()
      const neg = json.lines.find((l: { productId: string }) => l.productId === P_NEG)
      expect(neg).toMatchObject({ bookQty: -5, finalQty: 10, variance: 15, varianceValue: 1500, negativeBook: true })
      const two = json.lines.find((l: { productId: string }) => l.productId === P_TWO)
      expect(two).toMatchObject({ bookQty: 30, finalQty: 25, variance: -5, varianceValue: -300, multipleCounters: true })
      const b1 = two.batches.find((b: { batchId: string }) => b.batchId === B1)
      expect(b1).toMatchObject({ bookQty: 10, countedQty: 10, finalQty: 10, rule: 'counted' })
      expect(b1.counters).toHaveLength(2)
      expect(json.totals).toMatchObject({
        productsCounted: 2,
        negativesToClear: 1,
        unitsGained: 15,
        unitsLost: 5,
        valueGained: 1500,
        valueLost: 300,
        netValue: 1200,
      })
      expect(json.counters[COUNTER]).toBe('Joel Counter')
    })

    it('applies a manager recount to the review', async () => {
      const id = await countedTake()
      const missingReason = await putOverride(
        req('PUT', `/${id}/review`, { productId: P_TWO, batchKey: B1, overrideQty: 12 }),
        params(id),
      )
      expect(missingReason.status).toBe(400)
      const ok = await putOverride(
        req('PUT', `/${id}/review`, { productId: P_TWO, batchKey: B1, overrideQty: 12, reason: 'Recounted' }),
        params(id),
      )
      expect(ok.status).toBe(200)
      const json = await (await getReview(req('GET', `/${id}/review`), params(id))).json()
      const two = json.lines.find((l: { productId: string }) => l.productId === P_TWO)
      expect(two.batches.find((b: { batchId: string }) => b.batchId === B1)).toMatchObject({
        overrideQty: 12,
        finalQty: 12,
      })
      expect(two.finalQty).toBe(27)
    })

    it('refuses a recount on a batch of another product', async () => {
      const id = await countedTake()
      const res = await putOverride(
        req('PUT', `/${id}/review`, { productId: P_NEG, batchKey: B1, overrideQty: 1, reason: 'x' }),
        params(id),
      )
      expect(res.status).toBe(404)
    })

    it('refuses to post while counting is still open', async () => {
      const id = await countedTake()
      const res = await postTake(req('POST', `/${id}/post`), params(id))
      expect(res.status).toBe(409)
      expect(state.rpcCalls).toHaveLength(0)
    })

    it('posts through the single RPC with the caller’s tenant and actor', async () => {
      const id = await countedTake()
      await patchTake(req('PATCH', `/${id}`, { action: 'close' }), params(id))
      state.rpcResult = { data: { ok: true, productsChanged: 2, negativesCleared: 1 }, error: null }
      const res = await postTake(req('POST', `/${id}/post`), params(id))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, replay: false, summary: { negativesCleared: 1 } })
      expect(state.rpcCalls).toEqual([
        {
          name: 'post_pharmacy_stock_take',
          args: { p_tenant_id: TENANT_A, p_stock_take_id: id, p_actor_id: MANAGER },
        },
      ])
    })

    it('maps a database refusal to a clear status', async () => {
      const id = await countedTake()
      await patchTake(req('PATCH', `/${id}`, { action: 'close' }), params(id))
      state.rpcResult = { data: null, error: { message: 'PERMISSION: actor x is deactivated for this pharmacy' } }
      const res = await postTake(req('POST', `/${id}/post`), params(id))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('PERMISSION')
    })

    it('returns the stored summary when the take is already posted', async () => {
      const id = await countedTake()
      const row = state.tables.pharmacy_stock_takes.find((t) => t.id === id)!
      row.status = 'posted'
      row.posting_summary = { ok: true, productsChanged: 2 }
      const json = await (await postTake(req('POST', `/${id}/post`), params(id))).json()
      expect(json).toMatchObject({ ok: true, replay: true, summary: { productsChanged: 2 } })
      expect(state.rpcCalls).toHaveLength(0)
    })
  })
})
