import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_ACTIVATION_ERROR,
  ACCOUNT_UNAVAILABLE_ERROR,
  accountStateResponse,
  classifyAccountState,
} from '../../../../../../packages/auth/src/activation'

const mocks = vi.hoisted(() => ({
  suspendedIds: new Set<string>(),
  profile: null as Record<string, unknown> | null,
  settings: null as Record<string, unknown> | null,
  workspaces: [] as Array<Record<string, unknown>>,
  verifyOTP: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock('@synapse/auth', () => ({
  accountStateResponse,
  classifyAccountState,
  verifyOTP: (...a: unknown[]) => mocks.verifyOTP(...a),
  signToken: vi.fn(async () => 'signed'),
  createSession: (...a: unknown[]) => mocks.createSession(...a),  withMembershipSuspension: async (p: { id?: unknown }) => ({ ...p, membership_suspended: mocks.suspendedIds.has(String(p.id)) }),
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
vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: {
    from: () => {
      const q: any = { then: (r: any) => Promise.resolve({ data: null, error: null }).then(r) }
      for (const m of ['select', 'eq', 'update']) q[m] = vi.fn(() => q)
      q.single = vi.fn(async () => ({ data: mocks.profile, error: mocks.profile ? null : { code: 'PGRST116' } }))
      q.maybeSingle = vi.fn(async () => ({ data: mocks.settings, error: null }))
      return q
    },
  },
}))

async function verify() {
  const { POST } = await import('./route')
  const req = new Request('https://pharm.synapseos.tech/api/auth/otp-verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'pharm@example.test', otp: '123456' }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}

const verified = '2026-09-01T00:00:00.000Z'
const base = { id: 'u', role: 'pharmacist', tenant_id: 't', synapse_id: null, must_change_password: false, email_verified_at: verified, verification_status: 'verified', is_deleted: false }
const homeWorkspace = {
  tenantId: 't',
  name: 'Test Pharmacy',
  slug: 'test-pharmacy',
  facilityType: 'pharmacy',
  role: 'pharmacist',
  pharmacyRole: null,
  permissions: [],
  storeId: null,
  isHome: true,
}

describe('pharmacy POST /api/auth/otp-verify account-state gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyOTP.mockResolvedValue({ valid: true })
    mocks.suspendedIds = new Set()
    mocks.settings = null
    mocks.workspaces = [homeWorkspace]
  })

  it('deactivated pharmacy staff are refused a session after OTP proof', async () => {
    mocks.profile = { ...base }
    mocks.settings = { is_active: false }
    const r = await verify()
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('ACCOUNT_INACTIVE')
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('reactivated pharmacy staff can sign in with an email code again', async () => {
    mocks.profile = { ...base }
    mocks.settings = { is_active: true }
    const r = await verify()
    expect(r.status).toBe(200)
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
  })

  it('invalid OTP never reveals account state', async () => {
    mocks.verifyOTP.mockResolvedValue({ valid: false, error: 'INVALID' })
    mocks.profile = { ...base, is_deleted: true }
    const r = await verify()
    expect(r.status).toBe(401)
    expect(r.body.code).toBeUndefined()
  })

  it.each([
    ['archived', { is_deleted: true }, ACCOUNT_UNAVAILABLE_ERROR],
    ['suspended', { verification_status: 'suspended' }, ACCOUNT_UNAVAILABLE_ERROR],
    ['unverified', { email_verified_at: null }, ACCOUNT_ACTIVATION_ERROR],
  ])('%s identity is refused a session after OTP proof', async (_l, patch, message) => {
    mocks.profile = { ...base, ...patch }
    const r = await verify()
    expect(r.status).toBe(403)
    expect(r.body.error).toBe(message)
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('membership-suspended identity (verification_status verified) is refused a session after OTP proof', async () => {
    mocks.profile = { ...base }
    mocks.suspendedIds = new Set(['u'])
    const r = await verify()
    expect(r.status).toBe(403)
    expect(r.body.error).toBe(ACCOUNT_UNAVAILABLE_ERROR)
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('active identity gets a session', async () => {
    mocks.profile = { ...base }
    const r = await verify()
    expect(r.status).toBe(200)
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
  })

  it('an identity with no pharmacy workspace is refused after OTP proof', async () => {
    mocks.profile = { ...base }
    mocks.workspaces = []
    const r = await verify()
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('NO_PHARMACY_ACCESS')
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('several pharmacies without an echoed facility send the user back to sign in again', async () => {
    mocks.profile = { ...base }
    mocks.workspaces = [
      { ...homeWorkspace, tenantId: 't1', name: 'First', isHome: false },
      { ...homeWorkspace, tenantId: 't2', name: 'Second', isHome: false },
    ]
    const r = await verify()
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('CHOOSE_WORKSPACE')
    expect(mocks.createSession).not.toHaveBeenCalled()
  })
})
