import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { buildHmis105Report, hmis105Csv, type Hmis105DiagnosisRow } from '@synapse/interop/hmis105'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

/** Uganda is UTC+3 all year: a reporting month runs from local midnight on the 1st. */
const UTC_OFFSET_MS = 3 * 3_600_000
const ENCOUNTER_CAP = 20_000
const CHUNK = 400

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
  const db = supabaseAdmin as any
  const { data: encounters, error } = await db
    .from('encounters')
    .select('id, visit_date, patients(dob, date_of_birth, sex)')
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .eq('is_deleted', false)
    .gte('visit_date', bounds.start)
    .lt('visit_date', bounds.end)
    .limit(ENCOUNTER_CAP)
  if (error) return NextResponse.json({ error: 'Could not load encounters' }, { status: 500 })

  type Enc = { id: string; visit_date: string; patients?: { dob?: string | null; date_of_birth?: string | null; sex?: string | null } | null }
  const byId = new Map<string, Enc>((encounters ?? []).map((e: Enc) => [e.id, e]))
  const ids = [...byId.keys()]
  const rows: Hmis105DiagnosisRow[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data: dx, error: dxError } = await db
      .from('encounter_diagnoses')
      .select('encounter_id, stem_code, certainty')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_deleted', false)
      .in('encounter_id', ids.slice(i, i + CHUNK))
    if (dxError) return NextResponse.json({ error: 'Could not load diagnoses' }, { status: 500 })
    for (const d of (dx ?? []) as { encounter_id: string; stem_code: string; certainty: string | null }[]) {
      const e = byId.get(d.encounter_id)
      if (!e) continue
      rows.push({
        encounter_id: d.encounter_id,
        stem_code: d.stem_code,
        certainty: d.certainty,
        visit_date: e.visit_date,
        dob: e.patients?.dob ?? e.patients?.date_of_birth ?? null,
        sex: e.patients?.sex ?? null,
      })
    }
  }

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
    { ...report, encountersInPeriod: ids.length, truncated: ids.length >= ENCOUNTER_CAP },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
