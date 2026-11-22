import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { buildSurveillance } from '@synapse/interop/epi-surveillance'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'
import { loadFacilityDiagnoses } from '../../../../../lib/hospital-reports/load-diagnoses'

export const dynamic = 'force-dynamic'

const ENCOUNTER_CAP = 30_000

/**
 * Weekly surveillance for this facility: counts per HMIS group by
 * epidemiological week, IDSR-style alerts and a district breakdown.
 * ?weeks=4..52 (default 12). Aggregate counts only.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, 'report', 'read', 'clinical')
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const requested = Number(req.nextUrl.searchParams.get('weeks') ?? '12')
  const weeks = Number.isFinite(requested) ? Math.max(4, Math.min(52, Math.trunc(requested))) : 12
  const now = new Date()
  // One extra week so the first window week is complete in Kampala time.
  const start = new Date(now.getTime() - (weeks + 1) * 7 * 86_400_000).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loaded = await loadFacilityDiagnoses(supabaseAdmin as any, ctx, { start, end: now.toISOString() }, ENCOUNTER_CAP)
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 })

  return NextResponse.json(
    { ...buildSurveillance(loaded.rows, { weeks, now }), encounters: loaded.encounters, truncated: loaded.truncated },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
