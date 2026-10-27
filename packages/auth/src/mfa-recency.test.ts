import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), matching: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { from: mocks.from } }))
vi.mock('./totp', () => ({ matchingTotpTimeStep: mocks.matching }))
import { hasRecentVerifiedMfa, verifyStepUpMfa } from './mfa-recency'

type FakeQuery = {
  then: (resolve: (value: unknown) => unknown) => Promise<unknown>
  select: () => FakeQuery
  eq: () => FakeQuery
  is: () => FakeQuery
  gt: () => FakeQuery
  update: () => FakeQuery
  insert: () => FakeQuery
  maybeSingle: () => Promise<unknown>
}

function query(result: unknown): FakeQuery {
  const q = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) } as FakeQuery
  for (const method of ['select', 'eq', 'is', 'gt', 'update', 'insert'] as const) q[method] = vi.fn(() => q)
  q.maybeSingle = vi.fn(async () => result)
  return q
}
const liveSession = () => ({ user_id: 'u', revoked_at: null, expires_at: new Date(Date.now() + 60000).toISOString() })

describe('session MFA persistence boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.matching.mockResolvedValue(123) })

  it('does not report success when revocation races the assurance write', async () => {
    const update = query({ data: null, error: null })
    mocks.from.mockReturnValueOnce(query({ data: liveSession() }))
      .mockReturnValueOnce(query({ data: { id: 'e', secret: 'secret' } }))
      .mockReturnValueOnce(query({ error: null })).mockReturnValueOnce(update)
    expect(await verifyStepUpMfa('u', 's', '123456')).toEqual({ ok: false, code: 'ASSURANCE_WRITE_FAILED' })
    expect(update.is).toHaveBeenCalledWith('revoked_at', null)
    expect(update.gt).toHaveBeenCalledWith('expires_at', expect.any(String))
  })

  it('rejects a consumed code before stamping any session', async () => {
    mocks.from.mockReturnValueOnce(query({ data: liveSession() }))
      .mockReturnValueOnce(query({ data: { id: 'e', secret: 'secret' } }))
      .mockReturnValueOnce(query({ error: { code: '23505' } }))
    expect(await verifyStepUpMfa('u', 's', '123456')).toEqual({ ok: false, code: 'REPLAYED_CODE' })
    expect(mocks.from).toHaveBeenCalledTimes(3)
  })

  it('cannot inherit another session assurance', async () => {
    const q = query({ data: { ...liveSession(), mfa_assured_at: null } })
    mocks.from.mockReturnValue(q)
    expect(await hasRecentVerifiedMfa('u', 'second-session')).toBe(false)
    expect(q.eq).toHaveBeenCalledWith('id', 'second-session')
    expect(q.eq).toHaveBeenCalledWith('user_id', 'u')
  })

  it('fails closed on expired sessions without checking TOTP', async () => {
    mocks.from.mockReturnValue(query({ data: { ...liveSession(), expires_at: new Date(0).toISOString() } }))
    expect(await verifyStepUpMfa('u', 's', '123456')).toEqual({ ok: false, code: 'ASSURANCE_WRITE_FAILED' })
    expect(mocks.matching).not.toHaveBeenCalled()
  })
})
