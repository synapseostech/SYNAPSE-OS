import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { labReferenceRangeSchema } from '@/lib/lab/catalog'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, tenant_id, loinc_code, test_name, unit, sex, age_min_years, age_max_years, low, high, critical_low, critical_high, country_pack'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** This lab's intervals plus the national pack (tenant_id null) they override. */
export async function GET(request: Request) {
  const ctx = await requireLabAccess('result.read')
  if (isLabContextError(ctx)) return ctx
  const loinc = new URL(request.url).searchParams.get('loinc')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabaseAdmin as any).from('lab_reference_ranges').select(COLUMNS).or(`tenant_id.eq.${ctx.tenantId},tenant_id.is.null`)
  if (loinc && /^[0-9A-Za-z-]{1,40}$/.test(loinc)) query = query.eq('loinc_code', loinc)
  const { data, error } = await query.order('loinc_code').limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    ranges: (data ?? []).map((row: Record<string, unknown>) => ({ ...row, scope: row.tenant_id ? 'laboratory' : 'national' })),
  })
}

export async function POST(request: Request) {
  const ctx = await requireLabAccess('catalog.manage')
  if (isLabContextError(ctx)) return ctx
  const parsed = labReferenceRangeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const r = parsed.data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).from('lab_reference_ranges').insert({
    tenant_id: ctx.tenantId,
    loinc_code: r.loincCode,
    test_name: r.testName,
    unit: r.unit,
    sex: r.sex ?? null,
    age_min_years: r.ageMinYears ?? null,
    age_max_years: r.ageMaxYears ?? null,
    low: r.low,
    high: r.high,
    critical_low: r.criticalLow ?? null,
    critical_high: r.criticalHigh ?? null,
  }).select(COLUMNS).single()
  if (error) {
    const duplicate = /duplicate|unique/i.test(error.message ?? '')
    return NextResponse.json({ error: duplicate ? 'This lab already has an interval for that test, sex and age band' : error.message }, { status: duplicate ? 409 : 500 })
  }
  await logHospitalAudit({ ctx, action: 'LAB_REFERENCE_RANGE_CREATED', tableName: 'lab_reference_ranges', recordId: data.id, newValue: data })
  return NextResponse.json({ range: data }, { status: 201 })
}

/** Remove one of this lab's own intervals (the national pack cannot be removed here). */
export async function DELETE(request: Request) {
  const ctx = await requireLabAccess('catalog.manage')
  if (isLabContextError(ctx)) return ctx
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!UUID.test(id)) return NextResponse.json({ error: 'Range not found' }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).from('lab_reference_ranges').delete().eq('id', id).eq('tenant_id', ctx.tenantId).select('id').maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Range not found' }, { status: 404 })
  await logHospitalAudit({ ctx, action: 'LAB_REFERENCE_RANGE_DELETED', tableName: 'lab_reference_ranges', recordId: id })
  return NextResponse.json({ deleted: true })
}
