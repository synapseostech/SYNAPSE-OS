import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'

export const dynamic = 'force-dynamic'

/** Load the starter test list (no prices). Safe to repeat: existing codes are kept. */
export async function POST() {
  const ctx = await requireLabAccess('catalog.manage')
  if (isLabContextError(ctx)) return ctx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc('lab_seed_starter_catalog', { p_tenant_id: ctx.tenantId })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logHospitalAudit({ ctx, action: 'LAB_CATALOG_SEEDED', tableName: 'lab_test_catalog', recordId: ctx.tenantId, newValue: { added: data } })
  return NextResponse.json({ added: Number(data ?? 0) })
}
