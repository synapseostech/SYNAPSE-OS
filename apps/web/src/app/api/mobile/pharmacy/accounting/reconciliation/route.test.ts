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
  imports: [] as unknown[],
  lines: [] as unknown[],
  totalLines: 0,
  candidates: [] as unknown[],
  readError: null as unknown,
  rpcResult: { data: { id: 'import-1', replayed: false } as unknown, error: null as unknown },
}

const calls: { table: string; method: string; args: unknown[] }[] = []
const rpcCalls: { name: string; args: unknown }[] = []

type QueryResult = { data: unknown; error: unknown; count?: number }
type Builder = {
  select: (...args: unknown[]) => Builder
  eq: (...args: unknown[]) => Builder
  order: (...args: unknown[]) => Builder
  limit: (...args: unknown[]) => Promise<QueryResult>
  range: (...args: unknown[]) => Promise<QueryResult>
}

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder = {} as Builder
      for (const method of ['select', 'eq', 'order'] as const) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args })
          return builder
        }
      }
      builder.limit = (...args: unknown[]) => {
        calls.push({ table, method: 'limit', args })
        return Promise.resolve({ data: state.imports, error: null })
      }
      builder.range = (...args: unknown[]) => {
        calls.push({ table, method: 'range', args })
        return Promise.resolve({ data: state.lines, error: state.readError, count: state.totalLines })
      }
      return builder
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      if (name === 'pharmacy_accounting_bank_match_candidates') {
        return Promise.resolve({ data: state.candidates, error: state.readError })
      }
      return Promise.resolve(state.rpcResult)
    },
  },
}))

import { GET, PATCH, POST } from './route'

const TENANT = 'tenant-a'

function auth(role = 'pharmacy_admin', tenantId = TENANT) {
  return { userId: 'user-1', tenantId, role, token: 't' }
}

function get(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params)
  return new Request(
    `https://app.test/api/mobile/pharmacy/accounting/reconciliation?${query}`,
  ) as never
}

function body(payload: unknown) {
  return new Request('https://app.test/api/mobile/pharmacy/accounting/reconciliation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }) as never
}

const CSV = [
  'Date,Description,Amount,Reference',
  '2026-10-20,Customer deposit,125000.50,TX-1',
  '21/10/2026,Supplier payment,(25000.00),TX-2',
].join('\n')

const STATEMENT_LINE = {
  id: 'line-1',
  import_id: 'import-1',
  line_number: 2,
  statement_date: '2026-10-20',
  description: 'Customer deposit',
  reference: 'TX-1',
  currency: 'UGX',
  amount: '125000.50',
  matched_journal_line_id: null,
  matched_at: null,
  import: { file_name: 'october.csv' },
}

const CANDIDATE = {
  journal_line_id: 'jl-1',
  journal_entry_id: 'je-1',
  entry_no: 'JV-0007',
  entry_date: '2026-10-19',
  description: 'Customer deposit',
  currency: 'UGX',
  amount: '125000.50',
}

describe('mobile pharmacy bank reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    rpcCalls.length = 0
    state.imports = []
    state.lines = []
    state.totalLines = 0
    state.candidates = []
    state.readError = null
    state.rpcResult = { data: { id: 'import-1', replayed: false }, error: null }
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === 'object' &&
        !(value instanceof NextResponse) &&
        'tenantId' in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
  })

  it('denies reconciliation without the financial reports permission', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth('pharmacy_cashier'))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('rejects an invalid page', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get({ page: '0' }))

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('pages statement lines three hundred at a time', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get({ page: '2' }))

    expect(calls.find((call) => call.method === 'range')?.args).toEqual([300, 599])
    expect(rpcCalls.find((call) => call.name === 'pharmacy_accounting_bank_match_candidates')?.args).toEqual({
      p_tenant_id: TENANT,
    })
  })

  it('offers only exact amount and currency candidates to each open line', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.lines = [STATEMENT_LINE]
    state.totalLines = 1
    state.candidates = [
      CANDIDATE,
      { ...CANDIDATE, journal_line_id: 'jl-2', amount: '500.00' },
      { ...CANDIDATE, journal_line_id: 'jl-3', currency: 'USD' },
    ]

    const bodyJson = await (await GET(get())).json()

    expect(bodyJson.totalLines).toBe(1)
    expect(bodyJson.unmatchedOnPage).toBe(1)
    expect(bodyJson.matchedOnPage).toBe(0)
    expect(bodyJson.lines[0]).toMatchObject({
      id: 'line-1',
      fileName: 'october.csv',
      lineNumber: 2,
      date: '2026-10-20',
      reference: 'TX-1',
      currency: 'UGX',
      amount: 125000.5,
      matched: false,
    })
    expect(bodyJson.lines[0].candidates).toEqual([
      {
        journalLineId: 'jl-1',
        journalEntryId: 'je-1',
        entryNo: 'JV-0007',
        entryDate: '2026-10-19',
        description: 'Customer deposit',
        currency: 'UGX',
        amount: 125000.5,
      },
    ])
  })

  it('marks a reconciled line and offers it no candidates', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.lines = [
      { ...STATEMENT_LINE, matched_journal_line_id: 'jl-1', matched_at: '2026-10-21T09:00:00.000Z' },
    ]
    state.candidates = [CANDIDATE]

    const bodyJson = await (await GET(get())).json()

    expect(bodyJson.matchedOnPage).toBe(1)
    expect(bodyJson.unmatchedOnPage).toBe(0)
    expect(bodyJson.lines[0]).toMatchObject({
      matched: true,
      matchedJournalLineId: 'jl-1',
      matchedAt: '2026-10-21T09:00:00.000Z',
      candidates: [],
    })
  })

  it('reports a failed read as a server error', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.readError = { message: 'boom' }

    const res = await GET(get())

    expect(res.status).toBe(500)
  })

  it('denies an import without the financial reports permission', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth('pharmacy_cashier'))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await POST(body({ fileName: 'a.csv', currency: 'UGX', csv: CSV, idempotencyKey: 'k1' }))

    expect(res.status).toBe(403)
    expect(rpcCalls).toHaveLength(0)
  })

  it('requires the file name, currency and idempotency key', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(body({ fileName: 'a.csv', currency: 'UGX', csv: CSV }))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'A valid idempotency key is required.' })
  })

  it('rejects an empty paste', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(
      body({ fileName: 'a.csv', currency: 'UGX', csv: '   ', idempotencyKey: 'k1' }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Paste the statement CSV before importing.' })
  })

  it('rejects a CSV without the required columns, quoting the parser message', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(
      body({
        fileName: 'a.csv',
        currency: 'UGX',
        csv: 'Date,Amount\n2026-10-20,100',
        idempotencyKey: 'k1',
      }),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/needs Date, Description and Amount/i)
  })

  it('names the offending row when an amount is not a number', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(
      body({
        fileName: 'a.csv',
        currency: 'UGX',
        csv: 'Date,Description,Amount\n2026-10-20,Card sale,not-a-number',
        idempotencyKey: 'k1',
      }),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/row 2/i)
  })

  it('refuses rows that name another currency', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(
      body({
        fileName: 'a.csv',
        currency: 'UGX',
        csv: 'Date,Description,Amount,Currency\n2026-10-20,Card sale,100,USD',
        idempotencyKey: 'k1',
      }),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'Every statement row must use UGX; a row names another currency.',
    )
    expect(rpcCalls).toHaveLength(0)
  })

  it('imports the parsed rows through the same RPC as the portal', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(body({ fileName: 'october.csv', currency: 'ugx', csv: CSV, idempotencyKey: 'k1' }))

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ ok: true, importId: 'import-1', replayed: false, rowCount: 2 })
    expect(rpcCalls[0]).toEqual({
      name: 'import_pharmacy_bank_statement',
      args: {
        p_tenant_id: TENANT,
        p_file_name: 'october.csv',
        p_currency: 'UGX',
        p_imported_by: 'user-1',
        p_idempotency_key: 'k1',
        p_rows: [
          {
            lineNumber: 2,
            date: '2026-10-20',
            description: 'Customer deposit',
            reference: 'TX-1',
            amount: 125000.5,
            currency: 'UGX',
          },
          {
            lineNumber: 3,
            date: '2026-10-21',
            description: 'Supplier payment',
            reference: 'TX-2',
            amount: -25000,
            currency: 'UGX',
          },
        ],
      },
    })
  })

  it('answers a replayed import with 200', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rpcResult = { data: { id: 'import-1', replayed: true }, error: null }

    const res = await POST(body({ fileName: 'october.csv', currency: 'UGX', csv: CSV, idempotencyKey: 'k1' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ replayed: true })
  })

  it('maps an idempotency conflict to 409', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rpcResult = { data: null, error: { message: 'BANK_IMPORT_IDEMPOTENCY_CONFLICT' } }

    const res = await POST(body({ fileName: 'october.csv', currency: 'UGX', csv: CSV, idempotencyKey: 'k1' }))

    expect(res.status).toBe(409)
  })

  it('requires two valid ids before matching', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await PATCH(body({ statementLineId: 'nope', journalLineId: 'nope' }))

    expect(res.status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
  })

  it('matches a statement line and reports an amount mismatch', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rpcResult = { data: { replayed: false }, error: null }

    const ok = await PATCH(
      body({
        statementLineId: '11111111-1111-4111-8111-111111111111',
        journalLineId: '22222222-2222-4222-8222-222222222222',
      }),
    )
    expect(ok.status).toBe(201)
    expect(rpcCalls[0]).toEqual({
      name: 'match_pharmacy_bank_statement_line',
      args: {
        p_tenant_id: TENANT,
        p_statement_line_id: '11111111-1111-4111-8111-111111111111',
        p_journal_line_id: '22222222-2222-4222-8222-222222222222',
        p_matched_by: 'user-1',
      },
    })

    state.rpcResult = { data: null, error: { message: 'BANK_MATCH_AMOUNT_MISMATCH' } }
    const mismatch = await PATCH(
      body({
        statementLineId: '11111111-1111-4111-8111-111111111111',
        journalLineId: '22222222-2222-4222-8222-222222222222',
      }),
    )
    expect(mismatch.status).toBe(400)
  })

  it('maps an already-matched line to 409', async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rpcResult = { data: null, error: { message: 'BANK_STATEMENT_LINE_ALREADY_MATCHED' } }

    const res = await PATCH(
      body({
        statementLineId: '11111111-1111-4111-8111-111111111111',
        journalLineId: '22222222-2222-4222-8222-222222222222',
      }),
    )

    expect(res.status).toBe(409)
  })
})
