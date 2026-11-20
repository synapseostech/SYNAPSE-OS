import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HospitalContext } from './context'

const h = vi.hoisted(() => ({ require: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@synapse/auth/capability', () => {
  class CapabilityError extends Error {}
  return { CapabilityError, requireCapability: (...a: unknown[]) => h.require(...a) }
})

const ctx = (role: string): HospitalContext => ({
  userId: 'u', email: 'e', role, tenantId: 't', hospitalId: 'h', facilityType: 'hospital', fullName: null,
})

afterEach(async () => {
  vi.clearAllMocks()
  ;(await import('./guard')).resetHospitalCapabilityCache()
})

describe('requireHospitalCapability', () => {
  it('caches a grant per role and capability, so a warm instance skips the round trip', async () => {
    h.require.mockResolvedValue(undefined)
    const { requireHospitalCapability } = await import('./guard')
    expect(await requireHospitalCapability(ctx('cashier'), 'payment', 'record', 'billing')).toBeNull()
    expect(await requireHospitalCapability(ctx('cashier'), 'payment', 'record', 'billing')).toBeNull()
    expect(h.require).toHaveBeenCalledTimes(1)
    await requireHospitalCapability(ctx('nurse'), 'payment', 'record', 'billing')
    expect(h.require).toHaveBeenCalledTimes(2)
  })

  it('never caches a denial', async () => {
    const { CapabilityError } = await import('@synapse/auth/capability')
    h.require.mockRejectedValue(new CapabilityError())
    const { requireHospitalCapability } = await import('./guard')
    expect((await requireHospitalCapability(ctx('nurse'), 'payment', 'record', 'billing'))?.status).toBe(403)
    h.require.mockResolvedValue(undefined)
    expect(await requireHospitalCapability(ctx('nurse'), 'payment', 'record', 'billing')).toBeNull()
    expect(h.require).toHaveBeenCalledTimes(2)
  })

  it('checks hospital capabilities with the hospital facility type', async () => {
    h.require.mockResolvedValue(undefined)
    const { requireHospitalCapability } = await import('./guard')
    await requireHospitalCapability(ctx('doctor'), 'encounter', 'sign', 'opd')
    expect(h.require).toHaveBeenCalledWith({ role: 'doctor' }, 'opd', 'encounter', 'sign', 'hospital')
  })
})
