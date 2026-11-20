/**
 * Test double for '@/lib/lab/access'. Use in a test file:
 *   vi.mock('@/lib/lab/access', () => import('@/lib/lab/testing/access-double').then((m) => m.accessModule()))
 * then set `accessState.ctx`, `accessState.deny`, `accessState.claims`.
 */
import { NextResponse } from 'next/server'
import type { LabCapability, LabContext } from '../access'

export const LAB_TENANT = '0edb651a-232a-4289-9b3d-ae5bb1bac2cb'
export const LAB_HOSPITAL = '7a0c4a2e-1111-4aaa-8aaa-000000000001'
export const LAB_USER = '91456280-e996-4ff3-84ba-cada261d5062'

export const defaultLabCtx = (): LabContext => ({
  userId: LAB_USER, email: 's@lab.test', role: 'lab_scientist', tenantId: LAB_TENANT, hospitalId: LAB_HOSPITAL,
  facilityType: 'laboratory', fullName: 'Sarah Okello', facilityName: 'Kampala Diagnostics',
})

export const accessState: {
  ctx: LabContext
  deny: ((capability: LabCapability | null) => number | null) | null
  claims: { sub: string; role: string | null; email: string | null } | null
  calls: Array<LabCapability | null>
} = { ctx: defaultLabCtx(), deny: null, claims: { sub: LAB_USER, role: 'lab_scientist', email: 's@lab.test' }, calls: [] }

export function resetAccess() {
  accessState.ctx = defaultLabCtx()
  accessState.deny = null
  accessState.claims = { sub: LAB_USER, role: 'lab_scientist', email: 's@lab.test' }
  accessState.calls = []
}

async function guard(capability: LabCapability | null) {
  accessState.calls.push(capability)
  const status = accessState.deny?.(capability) ?? null
  if (status) return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  return accessState.ctx
}

export function accessModule() {
  return {
    requireLabAccess: (capability: LabCapability | null) => guard(capability),
    requireLabAccessFromRequest: (_req: Request, capability: LabCapability | null) => guard(capability),
    labAccessForToken: (_t: string, capability: LabCapability | null) => guard(capability),
    isLabContextError: (value: unknown): value is NextResponse => value instanceof NextResponse,
    peekLabSessionClaims: async () => accessState.claims,
    capabilityForLabAction: (action: string): LabCapability | null =>
      ['collect', 'receive', 'reject'].includes(action) ? 'specimen.collect'
        : action === 'enter_result' ? 'result.enter'
          : ['verify', 'release', 'authorise', 'amend', 'acknowledge'].includes(action) ? 'result.verify' : null,
  }
}
