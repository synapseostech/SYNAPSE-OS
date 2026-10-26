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
  rows: [] as unknown[],
  count: 0,
  error: null as unknown,
  accountLineIds: [] as unknown[],
}

const calls: { table: string; method: string; args: unknown[] }[] = []

type QueryResult = { data: unknown; error: unknown; count?: number }
type Builder = {
  select: (...args: unknown[]) => Builder
  eq: (...args: unknown[]) => Builder
  gte: (...args: unknown[]) => Builder
  lte: (...args: unknown[]) => Builder
  order: (...args: unknown[]) => Builder
  or: (...args: unknown[]) => Builder
  in: (...args: unknown[]) => Builder
  limit: (...args: unknown[]) => Promise<QueryResult>
  range: (...args: unknown[]) => Promise<QueryResult>
}

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder = {} as Builder
      for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'or', 'in'] as const) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args })
          return builder
        }
      }
      builder.limit = (...args: unknown[]) => {
        calls.push({ table, method: 'limit', args })
        return Promise.resolve({ data: state.accountLineIds, error: null })
      }
      builder.range = (...args: unknown[]) => {
        calls.push({ table, method: 'range', args })
        return Promise.resolve({ data: state.rows, error: state.error, count: state.count })
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
  const query = new URLSearchParams({ from: '2026-10-01', to: '2026-10-31', ...params })
  return new Request(`https://app.test/api/mobile/pharmacy/accounting/day-book?${query}`) as never
}

const ENTRY = {
  id: 'entry-1',
  entry_no: 'JV-0001',
  entry_date: '2026-10-20',
  source_type: 'sale',
  source_id: 'sale-9',
  description: 'Counter sale',
  currency: 'UGX',
  total_debit: '1200.00',
  total_credit: '1200.00',
  lines: [
    {
      id: 'line-1',
      debit: '1200.00',
      credit: '0',
      description: 'Cash',
      account: { id: 'acc-1', code: '1000', name: 'Cash on hand' },
    },
    {
      id: 'line-2',
      debit: '0',
      credit: '1200.00',
      description: null,
      account: { id: 'acc-2', code: '4000', name: 'Sales' },
    },
  ],
}

describe('mobile pharmacy day book', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    state.rows = []
    state.count = 0
    state.error = null
    state.accountLineIds = []
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === 'object' &&
        !(value instanceof NextResponse) &&
        'tenantId' in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
  })

  it('denies the day book without the financial reports permission', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth('pharmacy_cashier'))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('rejects an inverted date range', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ from: '2026-10-31', to: '2026-10-01' }))

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown voucher type', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ voucherType: 'payroll' }))

    expect(res.status).toBe(400)
  })

  it('maps entries and both sides of each posting', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rows = [ENTRY]
    state.count = 1

    const res = await GET(get())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.entries[0]).toMatchObject({
      id: 'entry-1',
      entryNo: 'JV-0001',
      date: '2026-10-20',
      voucherType: 'sales',
      voucherLabel: 'Sales',
      totalDebit: 1200,
      totalCredit: 1200,
    })
    expect(body.entries[0].lines[0]).toMatchObject({
      accountId: 'acc-1',
      accountCode: '1000',
      accountName: 'Cash on hand',
      debit: 1200,
      credit: 0,
    })
    expect(body.kinds).toContain('sales')
  })

  it('classifies a typed manual voucher from its source id', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rows = [
      {
        ...ENTRY,
        source_type: 'manual',
        source_id: 'manual:payment:key-1',
      },
    ]

    const body = await (await GET(get())).json()

    expect(body.entries[0]).toMatchObject({ voucherType: 'payment', voucherLabel: 'Payment' })
  })

  it('filters by voucher kind with the shared rule and pages the range', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get({ voucherType: 'payment', page: '2', pageSize: '10' }))

    const orCall = calls.find((call) => call.method === 'or')
    expect(String(orCall?.args[0])).toContain('source_id.like.manual:payment:%')
    expect(String(orCall?.args[0])).toContain('source_type.eq.supplier_payment')
    const rangeCall = calls.find((call) => call.method === 'range')
    expect(rangeCall?.args).toEqual([10, 19])
    expect(calls.find((call) => call.method === 'gte')?.args).toEqual(['entry_date', '2026-10-01'])
  })

  it('clamps an oversized page size', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get({ pageSize: '5000' }))

    expect(calls.find((call) => call.method === 'range')?.args).toEqual([0, 99])
  })

  it('returns nothing when the account has no postings', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.accountLineIds = []

    const res = await GET(get({ accountId: '11111111-1111-4111-8111-111111111111' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 0, entries: [] })
    expect(calls.some((call) => call.table === 'pharmacy_accounting_journal_entries')).toBe(false)
  })

  it('restricts entries to the account asked for', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.accountLineIds = [{ journal_entry_id: 'entry-1' }, { journal_entry_id: 'entry-1' }, { journal_entry_id: 'entry-2' }]

    await GET(get({ accountId: '11111111-1111-4111-8111-111111111111' }))

    expect(calls.find((call) => call.method === 'in')?.args).toEqual(['id', ['entry-1', 'entry-2']])
  })

  it('reports a failed read as a server error', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.error = { message: 'boom' }

    const res = await GET(get())

    expect(res.status).toBe(500)
  })
})
