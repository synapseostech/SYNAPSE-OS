import 'server-only'

import { NextResponse } from 'next/server'
import { gateFeature } from '@synapse/auth/features'
import { supabaseAdmin } from '@synapse/db/admin'
import { HOSPITAL_GATE_TTL_MS, TtlCache } from './ttl-cache'

// Platform-wide registry (changes on deploy/config) and per-hospital/per-tenant
// grants. Only positive answers are cached, so turning a module on is instant
// and turning it off takes effect within HOSPITAL_GATE_TTL_MS.
const registryCache = new TtlCache<ModuleRegistryEntry[]>(5 * 60_000, 1)
const moduleActive = new TtlCache<true>(HOSPITAL_GATE_TTL_MS)
const featureAllowed = new TtlCache<true>(HOSPITAL_GATE_TTL_MS)

export function resetHospitalModuleCache(): void {
  registryCache.clear()
  moduleActive.clear()
  featureAllowed.clear()
}

export interface ModuleRegistryEntry {
  key: string
  label: string
  default_enabled: boolean
  feature_key: string | null
}

export async function fetchModuleRegistry(): Promise<ModuleRegistryEntry[]> {
  const cached = registryCache.get('registry')
  if (cached) return cached
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data } = await db
    .from('platform_billing_config')
    .select('value')
    .eq('key', 'hospital_module_registry')
    .maybeSingle()

  if (!Array.isArray(data?.value)) return []
  const registry = data.value as ModuleRegistryEntry[]
  registryCache.set('registry', registry)
  return registry
}

export async function isHospitalModuleActive(
  hospitalId: string,
  moduleKey: string,
): Promise<boolean> {
  if (moduleKey === 'core' || moduleKey === 'platform') return true
  const key = `${hospitalId}|${moduleKey}`
  if (moduleActive.get(key)) return true

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data } = await db
    .from('hospital_modules')
    .select('is_active')
    .eq('hospital_id', hospitalId)
    .eq('module_key', moduleKey)
    .maybeSingle()

  const active = Boolean(data?.is_active)
  if (active) moduleActive.set(key, true)
  return active
}

/** Returns 403 when tenant module toggle is off; 402 when subscription feature missing. */
export async function gateHospitalModule(
  tenantId: string,
  hospitalId: string,
  moduleKey: string,
): Promise<NextResponse | null> {
  if (moduleKey === 'core' || moduleKey === 'platform') return null

  const active = await isHospitalModuleActive(hospitalId, moduleKey)
  if (!active) {
    return NextResponse.json(
      { error: 'module_disabled', module_key: moduleKey, message: `Module '${moduleKey}' is not enabled for this hospital.` },
      { status: 403 },
    )
  }

  const registry = await fetchModuleRegistry()
  const entry = registry.find((m) => m.key === moduleKey)
  if (entry?.feature_key) {
    const featureKey = `${tenantId}|${entry.feature_key}`
    if (!featureAllowed.get(featureKey)) {
      const featureBlock = await gateFeature(tenantId, entry.feature_key)
      if (featureBlock) return featureBlock
      featureAllowed.set(featureKey, true)
    }
  }

  return null
}
