import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { catalogInputToRow, labCatalogEntrySchema } from '@/lib/lab/catalog'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, code, loinc_code, name, section, specimen_type, container, unit, price, currency, turnaround_minutes, is_active, updated_at'

/** The tenant's test catalogue (anyone who can read orders can see what can be ordered). */
export async function GET(request: Request) {
  const ctx = await requireLabAccess('order.read')
  if (isLabContextError(ctx)) return ctx
  const params = new URL(request.url).searchParams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabaseAdmin as any).from('lab_test_catalog').select(COLUMNS).eq('tenant_id', ctx.tenantId)
  if (params.get('all') !== '1') query = query.eq('is_active', true)
  if (params.get('section')) query = query.eq('section', params.get('section'))
  const { data, error } = await query.order('section').order('name').limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tests: data ?? [] })
}

export async function POST(request: Request) {
  const ctx = await requireLabAccess('catalog.manage')
  if (isLabContextError(ctx)) return ctx
  const parsed = labCatalogEntrySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from('lab_test_catalog')
    .insert({ ...catalogInputToRow(parsed.data), tenant_id: ctx.tenantId })
    .select(COLUMNS)
    .single()
  if (error) {
    const duplicate = /duplicate|unique/i.test(error.message ?? '')
    return NextResponse.json({ error: duplicate ? 'A test with this code or LOINC already exists' : error.message }, { status: duplicate ? 409 : 500 })
  }
  await logHospitalAudit({ ctx, action: 'LAB_CATALOG_CREATED', tableName: 'lab_test_catalog', recordId: data.id, newValue: data })
  return NextResponse.json({ test: data }, { status: 201 })
}
