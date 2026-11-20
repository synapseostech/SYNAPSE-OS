import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createDbMock, MISSING_RPC, staff, TENANT_A, TENANT_B } from '../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('../../../../test-utils/hospital-route-mocks').createDbMock>,
  ctx: null as unknown,
}))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
}))
vi.mock('../../../../lib/hospital-dept', async () => ({
  ...(await import('../../../../lib/hospital-dept/rpc-errors')),
  requireHospitalStaffContext: async () => h.ctx,
}))

const req = (q: string, limit?: number) =>
  new NextRequest(`https://clinic.synapseos.tech/api/patients/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`)

afterEach(() => vi.clearAllMocks())

describe('GET /api/patients/search', () => {
  it('refuses without a staff session', async () => {
    h.ctx = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    h.db = createDbMock({})
    const { GET } = await import('./route')
    expect((await GET(req('nakato'))).status).toBe(401)
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it('searches with one RPC scoped to the session tenant, ignoring any tenant in the query string', async () => {
    h.ctx = staff('receptionist', TENANT_A)
    h.db = createDbMock({})
    h.db.setRpc('hospital_search_patients', {
      data: [{ id: 'p1', full_name: 'Nakato Sarah', mrn: 'A-1', dob: '1990-01-02', sex: 'F', phone_last4: '3456', match_kind: 'phone' }],
      error: null,
    })
    const { GET } = await import('./route')
    const res = await GET(new NextRequest(`https://x.test/api/patients/search?q=0772123456&tenant_id=${TENANT_B}`))
    expect(res.status).toBe(200)
    expect(h.db.rpcCalls).toEqual([
      { fn: 'hospital_search_patients', args: { p_tenant_id: TENANT_A, p_query: '0772123456', p_limit: 10 } },
    ])
    expect(h.db.calls).toHaveLength(0)
    const body = await res.json()
    expect(body.patients[0]).toEqual({
      id: 'p1', fullName: 'Nakato Sarah', mrn: 'A-1', dob: '1990-01-02', sex: 'F', phoneLast4: '3456', matchKind: 'phone',
    })
  })

  it('skips the database for one-character queries and clamps the limit', async () => {
    h.ctx = staff('nurse')
    h.db = createDbMock({})
    const { GET } = await import('./route')
    expect(await (await GET(req('a'))).json()).toEqual({ patients: [] })
    expect(h.db.rpcCalls).toHaveLength(0)
    await GET(req('ab', 500))
    expect(h.db.rpcCalls[0].args.p_limit).toBe(50)
  })

  it('falls back to tenant-filtered name/MRN queries until the migration is applied', async () => {
    h.ctx = staff('receptionist', TENANT_A)
    h.db = createDbMock({
      patients: [
        { data: [{ id: 'p1', full_name: 'Okello 50%', mrn: 'A-1' }], error: null },
        { data: [{ id: 'p1', full_name: 'Okello 50%', mrn: 'A-1' }], error: null },
      ],
    })
    h.db.setRpc('hospital_search_patients', MISSING_RPC)
    const { GET } = await import('./route')
    const res = await GET(req('50%'))
    expect(res.status).toBe(200)
    expect((await res.json()).patients).toHaveLength(1)
    expect(h.db.eqs('patients')).toContainEqual(['tenant_id', TENANT_A])
    const ilikes = h.db.calls.flatMap((c) => c.ops.filter(([op]) => op === 'ilike').map(([, a]) => a[1]))
    expect(ilikes).toEqual(['%50\\%%', '%50\\%%'])
  })

  it('returns 500 without leaking the database error', async () => {
    h.ctx = staff('receptionist')
    h.db = createDbMock({})
    h.db.setRpc('hospital_search_patients', { data: null, error: { code: 'XX000', message: 'relation secret_x' } })
    const { GET } = await import('./route')
    const res = await GET(req('nakato'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_x')
  })
})
