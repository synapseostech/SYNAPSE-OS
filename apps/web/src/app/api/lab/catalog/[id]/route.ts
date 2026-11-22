import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { catalogInputToRow, labCatalogPatchSchema } from '@/lib/lab/catalog'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Change price, section, turnaround, or switch a test off (tests are never deleted: orders point at them). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('catalog.manage')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Test not found' }, { status: 404 })
  const parsed = labCatalogPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const patch = catalogInputToRow(parsed.data)
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from('lab_test_catalog')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .select('id, code, name, section, price, currency, is_active, components')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: /duplicate|unique/i.test(error.message ?? '') ? 409 : 500 })
  if (!data) return NextResponse.json({ error: 'Test not found' }, { status: 404 })
  await logHospitalAudit({ ctx, action: 'LAB_CATALOG_UPDATED', tableName: 'lab_test_catalog', recordId: id, newValue: patch })
  return NextResponse.json({ test: data })
}
