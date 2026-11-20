import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { buildHmis105Report, hmis105Csv } from '@synapse/interop/hmis105'
import { loadFacilityDiagnoses } from '../../../../../lib/hospital-reports/load-diagnoses'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

/** Uganda is UTC+3 all year: a reporting month runs from local midnight on the 1st. */
const UTC_OFFSET_MS = 3 * 3_600_000
const ENCOUNTER_CAP = 20_000

function periodBounds(period: string): { start: string; end: string } | null {
  if (!/^\d{6}$/.test(period)) return null
  const y = Number(period.slice(0, 4))
  const m = Number(period.slice(4, 6)) - 1
  if (m < 0 || m > 11 || y < 2000 || y > 2100) return null
  return {
    start: new Date(Date.UTC(y, m, 1) - UTC_OFFSET_MS).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1) - UTC_OFFSET_MS).toISOString(),
  }
}

function currentPeriod(): string {
  const d = new Date(Date.now() + UTC_OFFSET_MS)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * HMIS 105 OPD diagnoses for one month at this facility, from coded ICD-11
 * diagnoses. ?period=YYYYMM (default this month), ?format=csv to download.
 * Aggregate counts only: no names or identifiers leave this route.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, 'report', 'read', 'clinical')
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const period = req.nextUrl.searchParams.get('period') ?? currentPeriod()
  const bounds = periodBounds(period)
  if (!bounds) return NextResponse.json({ error: 'period must be YYYYMM' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loaded = await loadFacilityDiagnoses(supabaseAdmin as any, ctx, bounds, ENCOUNTER_CAP)
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 })
  const { rows } = loaded
  const ids = { length: loaded.encounters }

  const report = buildHmis105Report(period, rows)
  if (req.nextUrl.searchParams.get('format') === 'csv') {
    return new NextResponse(hmis105Csv(report), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="HMIS105-OPD-diagnoses-${period}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    })
  }
  return NextResponse.json(
    { ...report, encountersInPeriod: ids.length, truncated: loaded.truncated },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
