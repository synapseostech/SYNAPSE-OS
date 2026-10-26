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

const ACCOUNT = '11111111-1111-4111-8111-111111111111'

const state = {
  account: null as Record<string, unknown> | null,
  settings: { currency: 'UGX' } as Record<string, unknown> | null,
  opening: [] as unknown[],
  closing: [] as unknown[],
  lines: [] as unknown[],
  accountError: null as unknown,
  lineError: null as unknown,
}

type Result = { data: unknown; error: unknown }
type Builder = {
  select: (...args: unknown[]) => Builder
  eq: (...args: unknown[]) => Builder
  gte: (...args: unknown[]) => Builder
  lte: (...args: unknown[]) => Builder
  order: (...args: unknown[]) => Builder
  maybeSingle: () => Promise<Result>
  limit: () => Promise<Result>
}

const rpc = vi.hoisted(() => vi.fn())

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => {
      const builder = {} as Builder
      for (const method of ['select', 'eq', 'gte', 'lte', 'order'] as const) {
        builder[method] = () => builder
      }
      builder.maybeSingle = () =>
        Promise.resolve(
          table === 'pharmacy_accounting_accounts'
            ? { data: state.account, error: state.accountError }
            : { data: state.settings, error: null },
        )
      builder.limit = () => Promise.resolve({ data: state.lines, error: state.lineError })
      return builder
    },
  },
}))

import { GET } from './route'

function auth(role = 'pharmacy_admin', tenantId = 'tenant-a') {
  return { userId: 'user-1', tenantId, role, token: 't' }
}

function get(params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    accountId: ACCOUNT,
    from: '2026-10-01',
    to: '2026-10-31',
    ...params,
  })
  return new Request(`https://app.test/api/mobile/pharmacy/accounting/ledger?${query}`) as never
}

function line(id: string, debit: number, credit: number, currency = 'UGX') {
  return {
    id,
    debit,
    credit,
    description: null,
    entry: {
      id: `entry-${id}`,
      entry_no: `JV-${id}`,
      entry_date: '2026-10-05',
      source_type: 'manual',
      source_id: 'manual:journal:key',
      description: 'Adjustment',
      currency,
    },
  }
}

function account(normalBalance: 'debit' | 'credit') {
  return {
    id: ACCOUNT,
    code: '1000',
    name: 'Cash on hand',
    account_type: 'asset',
    normal_balance: normalBalance,
  }
}

describe('mobile pharmacy general ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.account = account('debit')
    state.settings = { currency: 'UGX' }
    state.opening = [{ account_id: ACCOUNT, currency: 'UGX', balance: 1000 }]
    state.closing = [{ account_id: ACCOUNT, currency: 'UGX', balance: 1150 }]
    state.lines = [line('1', 200, 0), line('2', 0, 50)]
    state.accountError = null
    state.lineError = null
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === 'object' &&
        !(value instanceof NextResponse) &&
        'tenantId' in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
    rpc.mockImplementation((_fn: string, args: { p_to: string }) =>
      Promise.resolve({
        data: args.p_to === '2026-09-30' ? state.opening : state.closing,
        error: null,
      }),
    )
  })

  it('denies the ledger without the financial reports permission', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth('pharmacy_cashier'))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a request without a valid account id', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ accountId: 'cash' }))

    expect(res.status).toBe(400)
  })

  it('rejects an inverted date range', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ from: '2026-10-31', to: '2026-10-01' }))

    expect(res.status).toBe(400)
  })

  it('answers 404 for an account outside this pharmacy', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.account = null

    const res = await GET(get())

    expect(res.status).toBe(404)
  })

  it('runs the balance forward on a debit-normal account', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const body = await (await GET(get())).json()

    expect(body).toMatchObject({
      currency: 'UGX',
      openingBalance: 1000,
      closingBalance: 1150,
      totalDebit: 200,
      totalCredit: 50,
      truncated: false,
    })
    expect(body.lines.map((entry: { balance: number }) => entry.balance)).toEqual([1200, 1150])
    expect(body.lines[0]).toMatchObject({ entryNo: 'JV-1', date: '2026-10-05', debit: 200 })
  })

  it('runs the balance forward on the credit side of a credit-normal account', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.account = account('credit')
    state.opening = [{ account_id: ACCOUNT, currency: 'UGX', balance: 300 }]
    state.closing = [{ account_id: ACCOUNT, currency: 'UGX', balance: 250 }]
    state.lines = [line('1', 100, 0), line('2', 0, 50)]

    const body = await (await GET(get())).json()

    expect(body.lines.map((entry: { balance: number }) => entry.balance)).toEqual([200, 250])
  })

  it('reads the opening balance through the day before the range', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get())

    expect(rpc).toHaveBeenNthCalledWith(1, 'pharmacy_accounting_trial_balance', {
      p_tenant_id: 'tenant-a',
      p_from: null,
      p_to: '2026-09-30',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'pharmacy_accounting_trial_balance', {
      p_tenant_id: 'tenant-a',
      p_from: null,
      p_to: '2026-10-31',
    })
  })

  it('keeps only the selected currency', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.opening = [
      { account_id: ACCOUNT, currency: 'UGX', balance: 1000 },
      { account_id: ACCOUNT, currency: 'USD', balance: 40 },
    ]
    state.closing = [
      { account_id: ACCOUNT, currency: 'UGX', balance: 1150 },
      { account_id: ACCOUNT, currency: 'USD', balance: 45 },
    ]
    state.lines = [line('1', 200, 0, 'UGX'), line('2', 5, 0, 'USD')]

    const body = await (await GET(get({ currency: 'USD' }))).json()

    expect(body.currencies).toEqual(['UGX', 'USD'])
    expect(body.currency).toBe('USD')
    expect(body.openingBalance).toBe(40)
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0].debit).toBe(5)
  })

  it('flags a ledger too long to show in full', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.lines = Array.from({ length: 501 }, (_, index) => line(String(index), 1, 0))

    const body = await (await GET(get())).json()

    expect(body.truncated).toBe(true)
    expect(body.lines).toHaveLength(500)
  })

  it('reports a failed read as a server error', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.accountError = { message: 'boom' }

    const res = await GET(get())

    expect(res.status).toBe(500)
  })
})
