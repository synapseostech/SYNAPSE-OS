import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess } from '../../../../lib/lab/testing/access-double'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
const h = vi.hoisted(() => ({ run: vi.fn(), getCurrentUser: vi.fn(), engine: null as unknown }))
vi.mock('@/lib/lab/engine', async () => {
  class LabActionError extends Error { constructor(readonly code: string, readonly status: number, message?: string) { super(message ?? code) } }
  return {
    LabActionError,
    isLabAction: (a: string) => ['collect', 'receive', 'reject', 'enter_result', 'verify', 'release', 'authorise', 'amend', 'acknowledge'].includes(a),
    runLabAction: h.run,
  }
})
vi.mock('@/lib/auth/getCurrentUser', () => ({ getCurrentUser: h.getCurrentUser }))
vi.mock('@/lib/platform/auth', () => ({ hasPlatformAdminAccess: (role: string | null) => role === 'platform_admin' }))
vi.mock('@/lib/platform/simulation-runtime', () => ({ getSimulationEngine: () => h.engine }))

import { POST } from './route'
import { LabActionError } from '@/lib/lab/engine'

const ORDER = 'e76497a1-3a54-4984-827c-f6c339edbf99'
const post = (body: unknown) => POST(new Request('http://x/api/lab/actions', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => { vi.clearAllMocks(); resetAccess() })

describe('POST /api/lab/actions', () => {
  it('401 without a session', async () => {
    accessState.claims = null
    expect((await post({ orderId: ORDER, action: 'verify' })).status).toBe(401)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('400 for an unknown action before any access check', async () => {
    const res = await post({ orderId: ORDER, action: 'drop' })
    expect(res.status).toBe(400)
    expect(accessState.calls).toEqual([])
  })

  it.each([
    ['collect', 'specimen.collect'], ['receive', 'specimen.collect'], ['reject', 'specimen.collect'],
    ['enter_result', 'result.enter'], ['verify', 'result.verify'], ['authorise', 'result.verify'],
    ['release', 'result.verify'], ['amend', 'result.verify'], ['acknowledge', 'result.verify'],
  ])('%s requires lab.%s', async (action, capability) => {
    h.run.mockResolvedValue({ order: { id: ORDER, status: 'X' }, result: null, warnings: [], idempotent: false, reportId: null, critical: false })
    await post({ orderId: ORDER, action })
    expect(accessState.calls).toEqual([capability])
  })

  it('refuses a bench technician verifying (the capability check denies it) and never runs the action', async () => {
    accessState.ctx.role = 'lab_tech'
    accessState.deny = (cap) => (cap === 'result.verify' ? 403 : null)
    const res = await post({ orderId: ORDER, action: 'verify' })
    expect(res.status).toBe(403)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('runs the action as the session user and returns the label link after collection', async () => {
    h.run.mockResolvedValue({ order: { id: ORDER, status: 'COLLECTED', accessionNumber: 'LAB-1' }, result: null, warnings: ['W'], idempotent: false, reportId: null, critical: false, specimenId: 's' })
    const res = await post({ orderId: ORDER, action: 'collect', actorId: 'someone-else' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ source: 'database', labelUrl: `/api/lab/orders/${ORDER}/label`, warnings: ['W'] })
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ ctx: accessState.ctx, orderId: ORDER, action: 'collect' }))
  })

  it('maps engine errors to their status', async () => {
    h.run.mockRejectedValue(new LabActionError('LAB_STALE_ORDER', 409, 'changed'))
    const res = await post({ orderId: ORDER, action: 'enter_result', value: '1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'LAB_STALE_ORDER' })
  })

  it('platform operators still drive the simulation engine, with a validated session', async () => {
    accessState.claims = { sub: 'op', role: 'platform_admin', email: null }
    h.getCurrentUser.mockResolvedValue({ id: 'op', role: 'platform_admin', email: null })
    const lab = { verify: vi.fn(), getOrder: vi.fn(() => ({ id: ORDER })), snapshot: () => ({ results: [] }) }
    h.engine = { lab }
    const res = await post({ orderId: ORDER, action: 'verify' })
    expect(res.status).toBe(200)
    expect(lab.verify).toHaveBeenCalledWith(ORDER, 'op')
    expect(h.run).not.toHaveBeenCalled()
  })
})
