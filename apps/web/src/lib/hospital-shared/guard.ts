import 'server-only'

import { NextResponse } from 'next/server'
import { requireCapability, CapabilityError } from '@synapse/auth/capability'
import type { HospitalContext } from './context'
import { HOSPITAL_GATE_TTL_MS, TtlCache } from './ttl-cache'

// Role-level capability matrix answers (role, facility type, triple). Only grants
// are cached, so a denial is always re-checked and a new grant shows at once.
const allowed = new TtlCache<true>(HOSPITAL_GATE_TTL_MS)

export function resetHospitalCapabilityCache(): void {
  allowed.clear()
}

export async function requireHospitalCapability(
  ctx: HospitalContext,
  resource: string,
  action: string,
  module = 'config',
): Promise<NextResponse | null> {
  const facilityType = ['hospital', 'laboratory'].includes(ctx.facilityType) ? ctx.facilityType : 'any'
  const key = `${ctx.role}|${facilityType}|${module}|${resource}|${action}`
  if (allowed.get(key)) return null
  try {
    await requireCapability({ role: ctx.role }, module, resource, action, facilityType)
    allowed.set(key, true)
    return null
  } catch (e) {
    if (e instanceof CapabilityError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    throw e
  }
}
