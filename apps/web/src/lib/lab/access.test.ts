import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const h = vi.hoisted(() => ({ rpc: vi.fn(), verifyToken: vi.fn(), cookie: null as string | null }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: h.rpc } }))
vi.mock('@synapse/auth/tokens', () => ({ verifyToken: h.verifyToken }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (h.cookie ? { value: h.cookie } : undefined) }) }))

import { capabilityForLabAction, labAccessForToken, requireLabAccess, requireLabAccessFromRequest } from './access'

const CTX = { userId: 'u1', email: 'a@x', role: 'lab_admin', tenantId: 't1', hospitalId: 'h1', facilityType: 'laboratory', facilityName: 'Lab', fullName: 'A' }

beforeEach(() => {
  vi.clearAllMocks()
  h.verifyToken.mockResolvedValue({ sub: 'u1', role: 'lab_admin' })
  h.cookie = 'tok'
})

describe('lab access: one call', () => {
  it('sends the session hash, subject and capability to lab_access and returns its context', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, ctx: CTX }, error: null })
    const ctx = await labAccessForToken('tok', 'result.verify')
    expect(ctx).toEqual(CTX)
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith('lab_access', {
      p_token_hash: createHash('sha256').update('tok').digest('hex'),
      p_profile_id: 'u1',
      p_resource: 'result',
      p_action: 'verify',
    })
  })

  it('passes no capability when none is needed', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, ctx: CTX }, error: null })
    await requireLabAccess(null)
    expect(h.rpc.mock.calls[0]![1]).toMatchObject({ p_resource: null, p_action: null })
  })

  it.each([
    [{ ok: false, status: 401, error: 'Session expired' }, 401],
    [{ ok: false, status: 403, error: 'Forbidden', capability: 'lab.result.verify' }, 403],
    [{ ok: false, status: 403, error: 'module_disabled', module_key: 'lab' }, 403],
    [{ ok: false, status: 402, error: 'subscription_required', feature: 'lab' }, 402],
  ])('maps %j to HTTP %i', async (row, status) => {
    h.rpc.mockResolvedValue({ data: row, error: null })
    const res = await labAccessForToken('tok', 'order.read')
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(status)
    expect(await (res as Response).json()).toMatchObject({ error: row.error })
  })

  it('503 when the check itself fails, 401 without or with a bad token, and never calls the DB for a bad token', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect(((await labAccessForToken('tok', 'order.read')) as Response).status).toBe(503)
    expect(((await labAccessForToken(null, 'order.read')) as Response).status).toBe(401)
    h.rpc.mockClear()
    h.verifyToken.mockRejectedValue(new Error('bad'))
    expect(((await labAccessForToken('forged', 'order.read')) as Response).status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('reads a Bearer token for the APK', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, ctx: CTX }, error: null })
    await requireLabAccessFromRequest(new Request('http://x', { headers: { authorization: 'Bearer apk-token' } }), 'order.read')
    expect(h.rpc.mock.calls[0]![1].p_token_hash).toBe(createHash('sha256').update('apk-token').digest('hex'))
  })

  it('maps each workflow action to the capability a senior or bench role holds', () => {
    expect(capabilityForLabAction('collect')).toBe('specimen.collect')
    expect(capabilityForLabAction('enter_result')).toBe('result.enter')
    for (const a of ['verify', 'release', 'authorise', 'amend', 'acknowledge']) expect(capabilityForLabAction(a)).toBe('result.verify')
    expect(capabilityForLabAction('drop_table')).toBeNull()
  })
})
