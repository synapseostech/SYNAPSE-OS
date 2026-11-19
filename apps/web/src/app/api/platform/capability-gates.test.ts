/**
 * Route tests for the platform capability checks added with the staff role
 * model: each route is called as different platform roles, and the decision
 * comes from the real ROLE_CAPABILITIES in lib/platform/rbac.ts (only the
 * session lookup and the database are faked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const who = vi.hoisted(() => ({ role: 'SUPER_ADMIN' as string, writes: [] as Array<{ table: string; op: string }> }))

const { fakeAuth } = vi.hoisted(() => ({ fakeAuth: async () => {
  const rbac = await vi.importActual<typeof import('../../../lib/platform/rbac')>('../../../lib/platform/rbac')
  const { NextResponse } = await import('next/server')
  return {
    requirePlatformAdminApi: async (cap?: string) =>
      cap && !rbac.roleHasCapability(who.role as never, cap as never)
        ? { ok: false, response: NextResponse.json({ code: 'PLATFORM_FORBIDDEN' }, { status: 403 }) }
        : { ok: true, profile: { id: 'actor-1', sessionId: 'sess-1', email: 'a@p.test', platformRole: who.role } },
  }
} }))
// Routes import the guard both relatively and through the @/ alias.
vi.mock('../../../lib/platform/auth', fakeAuth)
vi.mock('@/lib/platform/auth', fakeAuth)
vi.mock('@/lib/platform/rbac', () => vi.importActual('../../../lib/platform/rbac'))

/** A PostgREST-shaped client that finds nothing and records writes. */
function emptyDb() {
  const chain = (table: string): any => {
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 })
          if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null })
          if (prop === 'update' || prop === 'insert' || prop === 'delete' || prop === 'upsert') {
            return () => {
              who.writes.push({ table, op: String(prop) })
              return q
            }
          }
          return () => q
        },
      },
    )
    return q
  }
  return { from: (table: string) => chain(table), rpc: async () => ({ data: null, error: { message: 'not in test' } }) }
}

vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: emptyDb() }))
vi.mock('../../../lib/supabase/server', () => ({ createServiceClient: () => emptyDb() }))
vi.mock('../../../lib/platform/production-truth', () => ({ getProductionTruth: async () => ({}) }))
vi.mock('../../platform/_lib/platform-data', () => ({ logPlatformEvent: vi.fn(async () => undefined) }))
vi.mock('@/app/platform/_lib/platform-data', () => ({ logPlatformEvent: vi.fn(async () => undefined) }))
vi.mock('@synapse/auth', () => ({ hasRecentVerifiedMfa: vi.fn(async () => true) }))

beforeEach(() => {
  who.role = 'SUPER_ADMIN'
  who.writes = []
})

const ctx = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) }
const lifecyclePost = async (body: unknown) => {
  const { POST } = await import('./facilities/[id]/lifecycle/route')
  return POST(new NextRequest('https://admin.synapseos.tech/api/platform/facilities/x/lifecycle', { method: 'POST', body: JSON.stringify(body) }), ctx)
}

describe('GET /api/platform/me', () => {
  it('lists only the console paths the role may open', async () => {
    const { GET } = await import('./me/route')
    who.role = 'AUDITOR'
    const auditor = await (await GET()).json()
    expect(auditor.allowedPaths).toEqual(expect.arrayContaining(['/platform/audit-log', '/platform/tenants', '/platform/health']))
    expect(auditor.allowedPaths).not.toContain('/platform/flags')
    expect(auditor.allowedPaths).not.toContain('/platform/applications')

    who.role = 'INVESTOR_OBSERVER'
    const investor = await (await GET()).json()
    expect(investor.allowedPaths).not.toContain('/platform/audit-log')
    expect(investor.allowedPaths).not.toContain('/platform/tenants')
    expect(investor.allowedPaths).not.toContain('/platform/users')
  })
})

describe('reads that used to admit any platform member', () => {
  it('global search (user emails, tickets, audit rows) needs tenant.read', async () => {
    const { GET } = await import('./search/route')
    const req = () => new NextRequest('https://admin.synapseos.tech/api/platform/search?q=ab')
    who.role = 'INVESTOR_OBSERVER'
    expect((await GET(req())).status).toBe(403)
    who.role = 'BOARD_OBSERVER'
    expect((await GET(req())).status).toBe(403)
    who.role = 'SUPPORT_ADMIN'
    expect((await GET(req())).status).toBe(200)
  })

  it('health probes need system_health.read', async () => {
    const { GET } = await import('./health/route')
    who.role = 'READ_ONLY_OBSERVER'
    expect((await GET()).status).toBe(403)
  })

  it('lifecycle impact needs tenant.read', async () => {
    const { GET } = await import('./facilities/[id]/lifecycle/route')
    who.role = 'INVESTOR_OBSERVER'
    expect((await GET(new NextRequest('https://admin.synapseos.tech/x'), ctx)).status).toBe(403)
    who.role = 'SUPPORT_ADMIN'
    // Past the gate: the empty database has no such tenant.
    expect((await GET(new NextRequest('https://admin.synapseos.tech/x'), ctx)).status).toBe(404)
  })
})

describe('POST /api/platform/facilities/[id]/lifecycle', () => {
  it('purge needs tenant.purge: a Platform admin is refused before anything is read or written', async () => {
    who.role = 'PLATFORM_ADMIN'
    const r = await lifecyclePost({ action: 'purge', reason: 'test', typedConfirmation: 'x', acknowledged: true })
    expect(r.status).toBe(403)
    expect((await r.json()).code).toBe('PLATFORM_FORBIDDEN')
    expect(who.writes).toEqual([])
  })

  it('a Super admin gets past the capability check to the purge safeguards', async () => {
    who.role = 'SUPER_ADMIN'
    const r = await lifecyclePost({ action: 'purge', reason: 'test', typedConfirmation: 'x', acknowledged: true })
    expect(r.status).toBe(404) // no such tenant in the empty database
  })

  it('Operations can suspend; the auditor and support cannot', async () => {
    who.role = 'OPERATIONS_ADMIN'
    expect((await lifecyclePost({ action: 'suspend', reason: 'unpaid' })).status).toBe(404)
    for (const role of ['AUDITOR', 'SUPPORT_ADMIN', 'FINANCE_ADMIN']) {
      who.role = role
      expect((await lifecyclePost({ action: 'suspend', reason: 'unpaid' })).status, role).toBe(403)
    }
    expect(who.writes).toEqual([])
  })
})
