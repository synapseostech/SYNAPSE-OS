import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountStateResponse, classifyAccountState } from '../../../../../../packages/auth/src/activation'

const mocks = vi.hoisted(() => ({
  suspendedIds: new Set<string>(),
  profile: null as Record<string, unknown> | null,
  settings: null as Record<string, unknown> | null,
  workspaces: [] as Array<Record<string, unknown>>,
  verifyPassword: vi.fn(),
  signToken: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock('@synapse/auth', () => ({
  accountStateResponse,
  classifyAccountState,
  verifyPassword: (...a: unknown[]) => mocks.verifyPassword(...a),
  createAndSendOTP: vi.fn(async () => '123456'),
  signToken: (...a: unknown[]) => mocks.signToken(...a),
  createSession: (...a: unknown[]) => mocks.createSession(...a),
  withMembershipSuspension: async (p: { id?: unknown }) => ({
    ...p,
    membership_suspended: mocks.suspendedIds.has(String(p.id)),
  }),
  listProfileWorkspaces: async () => mocks.workspaces,
  pickWorkspace: (list: Array<Record<string, unknown>>, tenantId?: string | null) => {
    const wanted = (tenantId ?? '').trim()
    if (wanted) return list.find((w) => w.tenantId === wanted) ?? null
    const home = list.find((w) => w.isHome)
    if (home) return home
    return list.length === 1 ? list[0] : null
  },
}))
vi.mock('@synapse/config/constants', () => ({ SESSION_COOKIE: 'synapse_session', SESSION_DURATION_DAYS: 1 }))
vi.mock('@synapse/email', () => ({ sendOTP: vi.fn(async () => undefined) }))
vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q: any = {}
      q.then = (r: any) => Promise.resolve({ data: null, error: null }).then(r)
      for (const m of ['select', 'eq', 'limit', 'order']) q[m] = vi.fn(() => q)
      q.update = vi.fn(() => q)
      q.single = vi.fn(async () => ({ data: mocks.profile, error: mocks.profile ? null : { code: 'PGRST116' } }))
      q.maybeSingle = vi.fn(async () =>
        table === 'pharmacy_user_settings'
          ? { data: mocks.settings, error: null }
          : { data: mocks.profile, error: mocks.profile ? null : { code: 'PGRST116' } },
      )
      return q
    },
  },
}))

async function login(body: Record<string, unknown> = {}) {
  const { POST } = await import('./route')
  const req = new Request('https://pharm.synapseos.tech/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'staff@example.test', password: 'correct-horse', ...body }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json(), session: res.cookies.get('synapse_session')?.value }
}

const base = {
  id: 'u1',
  email: 'staff@example.test',
  full_name: 'Test Staff',
  role: 'pharmacist',
  tenant_id: 't1',
  synapse_id: null,
  password_hash: 'hash',
  login_attempts: 0,
  locked_until: null,
  verification_status: 'verified',
  email_verified_at: '2026-09-01T00:00:00.000Z',
  is_deleted: false,
  must_change_password: false,
  onboarding_complete: true,
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 't1',
    name: 'Test Pharmacy',
    slug: 'test-pharmacy',
    facilityType: 'pharmacy',
    role: 'pharmacist',
    pharmacyRole: null,
    permissions: [],
    storeId: null,
    isHome: true,
    ...overrides,
  }
}

describe('pharmacy POST /api/auth/login workspace resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.suspendedIds = new Set()
    mocks.profile = { ...base }
    mocks.settings = null
    mocks.workspaces = [workspace()]
    mocks.verifyPassword.mockResolvedValue(true)
    mocks.signToken.mockResolvedValue('signed')
    mocks.createSession.mockResolvedValue(undefined)
  })

  it('an account with several pharmacies is asked to choose before a session exists', async () => {
    mocks.workspaces = [
      workspace({ tenantId: 't1', isHome: true }),
      workspace({ tenantId: 't2', name: 'Second', isHome: false }),
    ]

    const r = await login()

    expect(r.status).toBe(409)
    expect(r.body.code).toBe('CHOOSE_WORKSPACE')
    expect(r.body.workspaces).toHaveLength(2)
    // The picker is pre-session, so it carries no roles or permissions.
    expect(Object.keys(r.body.workspaces[0]).sort()).toEqual(['name', 'slug', 'tenantId'])
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(r.session).toBeUndefined()
  })

  it('an account with no pharmacy workspace is refused', async () => {
    mocks.workspaces = []

    const r = await login()

    expect(r.status).toBe(403)
    expect(r.body.code).toBe('NO_PHARMACY_ACCESS')
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('a facility the account does not hold is refused', async () => {
    mocks.workspaces = [workspace({ tenantId: 't1' })]

    const r = await login({ tenantId: 't2' })

    expect(r.status).toBe(403)
    expect(r.body.code).toBe('NO_PHARMACY_ACCESS')
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('control-plane staff sign in through a tenant-less platform workspace', async () => {
    mocks.profile = { ...base, role: 'platform_admin', tenant_id: null }
    mocks.workspaces = []

    const r = await login()

    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.role).toBe('platform_admin')
    expect(r.body.tenantId).toBe('')
    expect(mocks.signToken).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: '', app: 'pharmacy', role: 'platform_admin' }),
    )
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
  })

  it('a non-pharmacy facility is never offered as a pharmacy workspace', async () => {
    mocks.profile = { ...base, role: 'nurse' }
    mocks.workspaces = [workspace({ tenantId: 'h1', facilityType: 'hospital', role: 'nurse' })]

    const r = await login()

    expect(r.status).toBe(403)
    expect(r.body.code).toBe('NO_PHARMACY_ACCESS')
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('a pharmacy posting alongside a hospital signs in without a chooser', async () => {
    mocks.workspaces = [
      workspace({ tenantId: 'h1', facilityType: 'hospital', name: 'Hospital' }),
      workspace({ tenantId: 't1', facilityType: 'pharmacy' }),
    ]

    const r = await login()

    expect(r.status).toBe(200)
    expect(r.body.tenantId).toBe('t1')
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
  })

  it('the chosen pharmacy is the one the token is minted for', async () => {
    mocks.workspaces = [
      workspace({ tenantId: 't1', isHome: true }),
      workspace({ tenantId: 't2', name: 'Second', isHome: false }),
    ]

    const r = await login({ tenantId: 't2' })

    expect(r.status).toBe(200)
    expect(r.body.tenantId).toBe('t2')
    expect(mocks.signToken).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't2' }))
  })
})
