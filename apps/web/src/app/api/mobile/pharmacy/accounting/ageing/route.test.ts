import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock('../../../../../../lib/mobile-pharmacy-auth', () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

const state = {
  currency: 'UGX',
  settingsError: null as unknown,
  creditRows: [] as unknown[],
  creditError: null as unknown,
  purchaseRows: [] as unknown[],
  purchaseError: null as unknown,
}

const calls: { table: string; method: string; args: unknown[] }[] = []

type QueryResult = { data: unknown; error: unknown }
type Builder = {
  select: (...args: unknown[]) => Builder
  eq: (...args: unknown[]) => Builder
  lte: (...args: unknown[]) => Builder
  gt: (...args: unknown[]) => Builder
  order: (...args: unknown[]) => Builder
  limit: (...args: unknown[]) => Promise<QueryResult>
  maybeSingle: (...args: unknown[]) => Promise<QueryResult>
}

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder = {} as Builder
      for (const method of ['select', 'eq', 'lte', 'gt', 'order'] as const) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args })
          return builder
        }
      }
      builder.limit = (...args: unknown[]) => {
        calls.push({ table, method: 'limit', args })
        if (table === 'pharmacy_credit_ledger') {
          return Promise.resolve({ data: state.creditRows, error: state.creditError })
        }
        return Promise.resolve({ data: state.purchaseRows, error: state.purchaseError })
      }
      builder.maybeSingle = (...args: unknown[]) => {
        calls.push({ table, method: 'maybeSingle', args })
        return Promise.resolve({ data: { currency: state.currency }, error: state.settingsError })
      }
      return builder
    },
  },
}))

import { GET } from './route'

function auth(role = 'pharmacy_admin', tenantId = 'tenant-a') {
  return { userId: 'user-1', tenantId, role, token: 't' }
}

function get(params: Record<string, string> = {}) {
  const query = new URLSearchParams({ asOf: '2026-04-02', ...params })
  return new Request(`https://app.test/api/mobile/pharmacy/accounting/ageing?${query}`) as never
}

function creditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'credit-1',
    customer_id: 'cust-1',
    transaction_id: 'txn-1',
    amount: '300.00',
    type: 'credit',
    due_date: '2026-01-01',
    created_at: '2025-12-28T10:00:00.000Z',
    customer: { name: 'Test Party A' },
    ...overrides,
  }
}

describe('mobile pharmacy ageing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    state.currency = 'UGX'
    state.settingsError = null
    state.creditRows = []
    state.creditError = null
    state.purchaseRows = []
    state.purchaseError = null
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === 'object' &&
        !(value instanceof NextResponse) &&
        'tenantId' in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
  })

  it('denies ageing without the financial reports permission', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth('pharmacy_cashier'))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('rejects an invalid as-of date', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ asOf: '2026-02-30' }))

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown side', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ side: 'ledger' }))

    expect(res.status).toBe(400)
  })

  it('settles the oldest receivable first and buckets it by due date', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.creditRows = [
      creditRow({ id: 'credit-old', transaction_id: 'txn-old' }),
      creditRow({
        id: 'credit-new',
        transaction_id: 'txn-new',
        amount: '200.00',
        due_date: '2026-02-01',
        created_at: '2026-01-28T10:00:00.000Z',
      }),
      creditRow({
        id: 'repay-1',
        amount: '150.00',
        type: 'repayment',
        due_date: null,
        transaction_id: null,
      }),
    ]

    const res = await GET(get({ side: 'receivable' }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.receivable).toMatchObject({
      currency: 'UGX',
      customerCount: 1,
      total: 350,
      buckets: { current: 0, d1_30: 0, d31_60: 200, d61_90: 0, d90_plus: 150 },
      rowCount: 2,
      truncated: false,
    })
    expect(body.receivable.rows.map((row: { reference: string }) => row.reference)).toEqual([
      'TXN-txn-old',
      'TXN-txn-new',
    ])
    expect(body.receivable.rows[0]).toMatchObject({
      partyName: 'Test Party A',
      date: '2025-12-28',
      dueDate: '2026-01-01',
      amount: 150,
      daysOverdue: 91,
      bucket: 'd90_plus',
    })
    expect(body.payable).toBeUndefined()
  })

  it('keeps each customer separate and names a walk-in without one', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.creditRows = [
      creditRow({ id: 'credit-a', customer_id: 'cust-1' }),
      creditRow({
        id: 'credit-b',
        customer_id: 'cust-2',
        amount: '50.00',
        customer: { name: 'Test Party B' },
      }),
      creditRow({
        id: 'credit-c',
        customer_id: null,
        amount: '25.00',
        customer: null,
      }),
    ]

    const body = await (await GET(get({ side: 'receivable' }))).json()

    expect(body.receivable.customerCount).toBe(3)
    expect(
      [...new Set(body.receivable.rows.map((row: { partyName: string }) => row.partyName))].sort(),
    ).toEqual(['Test Party A', 'Test Party B', 'Walk-in customer'])
    expect(body.receivable.total).toBe(375)
  })

  it('ages supplier bills from the purchase date, per currency', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.purchaseRows = [
      {
        id: 'po-1',
        purchase_no: 'PO-0001',
        purchase_date: '2026-03-03',
        balance: '400.00',
        currency: 'UGX',
        supplier: { name: 'Test Supplier A' },
      },
      {
        id: 'po-2',
        purchase_no: 'PO-0002',
        purchase_date: '2026-01-31',
        balance: '100.00',
        currency: 'USD',
        supplier: { name: 'Test Supplier B' },
      },
    ]

    const body = await (await GET(get({ side: 'payable' }))).json()

    expect(body.receivable).toBeUndefined()
    expect(body.payable).toHaveLength(2)
    expect(body.payable[0]).toMatchObject({
      currency: 'UGX',
      supplierCount: 1,
      total: 400,
      buckets: { current: 0, d1_30: 400, d31_60: 0, d61_90: 0, d90_plus: 0 },
    })
    expect(body.payable[0].rows[0]).toMatchObject({
      partyName: 'Test Supplier A',
      reference: 'PO-0001',
      date: '2026-03-03',
      dueDate: '2026-03-03',
      daysOverdue: 30,
      amount: 400,
    })
    expect(body.payable[1]).toMatchObject({
      currency: 'USD',
      total: 100,
      buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 100, d90_plus: 0 },
    })
  })

  it('reads only the side it was asked for', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get({ side: 'payable' }))
    expect(calls.some((call) => call.table === 'pharmacy_credit_ledger')).toBe(false)

    calls.length = 0
    await GET(get({ side: 'receivable' }))
    expect(calls.some((call) => call.table === 'pharmacy_purchases')).toBe(false)
  })

  it('reads both sides and the bucket definitions when no side is given', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.creditRows = [creditRow()]

    const body = await (await GET(get())).json()

    expect(calls.some((call) => call.table === 'pharmacy_credit_ledger')).toBe(true)
    expect(calls.some((call) => call.table === 'pharmacy_purchases')).toBe(true)
    expect(body.bucketDefinitions.map((bucket: { id: string }) => bucket.id)).toEqual([
      'current',
      'd1_30',
      'd31_60',
      'd61_90',
      'd90_plus',
    ])
    expect(body.bucketDefinitions[1].label).toBe('1–30 days')
    expect(body.allocation).toBe('oldest-first')
  })

  it('caps the lines it returns but reports how many are open', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.creditRows = Array.from({ length: 201 }, (_, index) =>
      creditRow({ id: `credit-${index}`, transaction_id: null, amount: '10.00' }),
    )

    const body = await (await GET(get({ side: 'receivable' }))).json()

    expect(body.receivable.rows).toHaveLength(200)
    expect(body.receivable.rowCount).toBe(201)
    expect(body.receivable.truncated).toBe(true)
    expect(body.receivable.total).toBe(2010)
  })

  it('caps the rows it reads from the ledger', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get({ side: 'receivable' }))

    expect(calls.find((call) => call.method === 'limit')?.args).toEqual([20_000])
  })

  it('filters receivables to what existed by the as-of date', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get({ asOf: '2026-03-31' }))

    expect(calls.find((call) => call.table === 'pharmacy_credit_ledger' && call.method === 'lte')?.args).toEqual([
      'created_at',
      '2026-03-31T23:59:59.999Z',
    ])
    expect(calls.find((call) => call.table === 'pharmacy_purchases' && call.method === 'gt')?.args).toEqual([
      'balance',
      0,
    ])
  })

  it('reports a failed ledger read as a server error', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.creditError = { message: 'boom' }

    const res = await GET(get({ side: 'receivable' }))

    expect(res.status).toBe(500)
  })
})
