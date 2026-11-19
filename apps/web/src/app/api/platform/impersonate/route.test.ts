import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const m = vi.hoisted(() => ({
  actorRole: 'INVESTOR_OBSERVER' as string,
  stepUp: true,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  inserts: [] as Array<{ table: string; values: unknown }>,
}))

const CAPS: Record<string, string[]> = {
  PLATFORM_ADMIN: ['tenant.manage', 'tenant.impersonate'],
  // Can manage tenants but was not given impersonation.
  TENANT_ONLY: ['tenant.manage'],
  INVESTOR_OBSERVER: [],
}
const profile = () => ({ id: 'actor-1', email: 'actor@p.test', platformRole: m.actorRole })

vi.mock('@/lib/platform/auth', () => ({
  // Legacy guard: any platform membership passes.
  requirePlatformAdmin: vi.fn(async () => profile()),
  requirePlatformAdminApi: vi.fn(async (cap?: string) =>
    cap && !(CAPS[m.actorRole] ?? []).includes(cap)
      ? { ok: false, response: NextResponse.json({ code: 'PLATFORM_FORBIDDEN' }, { status: 403 }) }
      : { ok: true, profile: profile() },
  ),
}))
vi.mock('@/lib/platform/step-up', () => ({
  stepUpResponse: vi.fn(async () =>
    m.stepUp ? null : NextResponse.json({ code: 'MFA_STEP_UP_REQUIRED' }, { status: 403 }),
  ),
}))
vi.mock('@synapse/auth/tokens', () => ({ signToken: vi.fn(async () => 'signed.token') }))
vi.mock('../../../platform/_lib/platform-data', () => ({ logPlatformEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const eqs: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => ((eqs[k] = v), q),
        in: () => q,
        insert: async (values: unknown) => (m.inserts.push({ table, values }), { error: null }),
        maybeSingle: async () => ({
          data: (m.tables[table] ?? []).find((r) => Object.entries(eqs).every(([k, v]) => r[k] === v)) ?? null,
          error: null,
        }),
      }
      return q
    },
  }),
}))

async function start(targetUserId: string) {
  const { POST } = await import('./route')
  const { NextRequest } = await import('next/server')
  const res = await POST(new NextRequest('https://admin.synapseos.tech/api/platform/impersonate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId }),
  }))
  const body = await res.json().catch(() => ({}))
  return { status: res.status, code: (body as { code?: string }).code }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.inserts = []
  m.actorRole = 'PLATFORM_ADMIN'
  m.stepUp = true
  m.tables = {
    profiles: [
      { id: 'staff-1', email: 's@t.test', role: 'pharmacist', tenant_id: 'tenant-1' },
      { id: 'support-1', email: 'sup@p.test', role: 'support', tenant_id: 'tenant-1' },
    ],
    platform_memberships: [{ user_id: 'support-1', status: 'ACTIVE', platform_role: 'SUPPORT_ADMIN' }],
    tenants: [{ id: 'tenant-1', name: 'T1' }],
  }
})

describe('POST /api/platform/impersonate', () => {
  it('refuses a platform observer (membership without tenant.manage) and mints no session', async () => {
    m.actorRole = 'INVESTOR_OBSERVER'
    const r = await start('staff-1')
    expect(r.status).toBe(403)
    expect(m.inserts).toEqual([])
  })

  it('refuses tenant.manage without tenant.impersonate', async () => {
    m.actorRole = 'TENANT_ONLY'
    const r = await start('staff-1')
    expect(r.status).toBe(403)
    expect(m.inserts).toEqual([])
  })

  it('needs a fresh authenticator code even with the capability', async () => {
    m.stepUp = false
    const r = await start('staff-1')
    expect(r.status).toBe(403)
    expect(r.code).toBe('MFA_STEP_UP_REQUIRED')
    expect(m.inserts).toEqual([])
  })

  it('refuses to impersonate any platform control-plane member, not only role=platform_admin', async () => {
    const r = await start('support-1')
    expect(r.status).toBe(403)
    expect(m.inserts).toEqual([])
  })

  it('allows a platform admin to impersonate an ordinary tenant user', async () => {
    const r = await start('staff-1')
    expect(r.status).toBe(200)
    expect(m.inserts.map((i) => i.table)).toEqual(['synapse_sessions'])
  })
})
