import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createDbMock, MISSING_RPC, TENANT_A } from '../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({
  db: null as never as ReturnType<typeof createDbMock>,
  token: 'tok' as string | undefined,
  payload: { sub: 'user-1', role: 'nurse', email: 'n@x' } as Record<string, unknown> | null,
  validate: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (h.token ? { value: h.token } : undefined) }),
}))
vi.mock('@synapse/auth/tokens', () => ({
  verifyToken: async () => {
    if (!h.payload) throw new Error('bad')
    return h.payload
  },
}))
vi.mock('@synapse/auth', () => ({
  hashToken: (t: string) => `hash:${t}`,
  validateSession: (...a: unknown[]) => h.validate(...a),
}))
vi.mock('@synapse/config/constants', () => ({ SESSION_COOKIE: 'synapse_session' }))
vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))

const okRow = {
  status: 'ok', user_id: 'user-1', email: 'n@x', role: 'nurse', full_name: 'Nurse', tenant_id: TENANT_A,
  hospital_id: 'hosp-1', facility_type: 'hospital',
}

beforeEach(() => {
  h.token = 'tok'
  h.payload = { sub: 'user-1', role: 'nurse', email: 'n@x' }
})
afterEach(() => vi.clearAllMocks())

describe('requireHospitalStaffContext', () => {
  it('resolves session, profile, tenant and hospital in one RPC', async () => {
    h.db = createDbMock({})
    h.db.setRpc('hospital_staff_context', { data: okRow, error: null })
    const { requireHospitalStaffContext } = await import('./context')
    const ctx = await requireHospitalStaffContext()
    expect(ctx).toEqual({
      userId: 'user-1', email: 'n@x', role: 'nurse', tenantId: TENANT_A, hospitalId: 'hosp-1', facilityType: 'hospital', fullName: 'Nurse',
    })
    expect(h.db.rpcCalls).toEqual([{ fn: 'hospital_staff_context', args: { p_token_hash: 'hash:tok', p_user_id: 'user-1' } }])
    expect(h.db.calls).toHaveLength(0)
    expect(h.validate).not.toHaveBeenCalled()
  })

  it.each([
    ['no cookie', () => { h.token = undefined }, 401],
    ['bad token', () => { h.payload = null }, 401],
  ])('401 on %s without touching the database', async (_name, arrange, status) => {
    h.db = createDbMock({})
    arrange()
    const { requireHospitalStaffContext } = await import('./context')
    const res = await requireHospitalStaffContext()
    expect((res as NextResponse).status).toBe(status)
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it.each([
    [{ status: 'session_invalid' }, 401],
    [{ status: 'no_tenant' }, 403],
    [{ ...okRow, facility_type: 'pharmacy' }, 403],
    [{ ...okRow, hospital_id: null }, 403],
  ])('refuses %o with %i', async (row, status) => {
    h.db = createDbMock({})
    h.db.setRpc('hospital_staff_context', { data: row, error: null })
    const { requireHospitalStaffContext } = await import('./context')
    expect(((await requireHospitalStaffContext()) as NextResponse).status).toBe(status)
  })

  it('lets a platform admin into a non-hospital tenant (platform roles from #43)', async () => {
    h.db = createDbMock({})
    h.db.setRpc('hospital_staff_context', { data: { ...okRow, role: 'platform_admin', facility_type: 'pharmacy' }, error: null })
    const { requireHospitalStaffContext } = await import('./context')
    expect(await requireHospitalStaffContext()).toMatchObject({ role: 'platform_admin' })
  })

  it('fails closed (503) when the context RPC errors', async () => {
    h.db = createDbMock({})
    h.db.setRpc('hospital_staff_context', { data: null, error: { code: '57014', message: 'timeout' } })
    const { requireHospitalStaffContext } = await import('./context')
    expect(((await requireHospitalStaffContext()) as NextResponse).status).toBe(503)
  })

  it('falls back to the sequential reads before the migration, rejecting another user\'s session', async () => {
    h.db = createDbMock({
      profiles: { data: { id: 'user-1', email: 'n@x', role: 'nurse', full_name: 'Nurse', tenant_id: TENANT_A, hospital_id: 'hosp-1' }, error: null },
      tenants: { data: { facility_type: 'hospital', slug: 'clinic-a' }, error: null },
    })
    h.db.setRpc('hospital_staff_context', MISSING_RPC)
    h.validate.mockResolvedValue({ valid: true, userId: 'user-1' })
    const { requireHospitalStaffContext } = await import('./context')
    expect(await requireHospitalStaffContext()).toMatchObject({ tenantId: TENANT_A, hospitalId: 'hosp-1' })

    h.validate.mockResolvedValue({ valid: true, userId: 'someone-else' })
    expect(((await requireHospitalStaffContext()) as NextResponse).status).toBe(401)
  })
})
