import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { qcMaterialSchema, qcMaterialToRow } from '@/lib/lab/qc'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, loinc_code, analyte_name, unit, material_name, lot_number, level, target_mean, target_sd, expires_on, device_id, is_active, last_run_at, last_run_status, updated_at'

/** Set up a control level for an analyte (lot, level, target mean and SD). */
export async function POST(request: Request) {
  const ctx = await requireLabAccess('qc.manage')
  if (isLabContextError(ctx)) return ctx
  const parsed = qcMaterialSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  if (parsed.data.deviceId) {
    const { data: device } = await db.from('lab_devices').select('id').eq('id', parsed.data.deviceId).eq('tenant_id', ctx.tenantId).maybeSingle()
    if (!device) return NextResponse.json({ error: 'Analyser not found' }, { status: 400 })
  }
  const { data, error } = await db
    .from('lab_qc_materials')
    .insert({ ...qcMaterialToRow(parsed.data), tenant_id: ctx.tenantId, created_by: ctx.userId })
    .select(COLUMNS)
    .single()
  if (error) {
    const duplicate = /duplicate|unique/i.test(error.message ?? '')
    return NextResponse.json(
      { error: duplicate ? 'This analyte already has an active control for that level and lot' : 'Could not save the control' },
      { status: duplicate ? 409 : 500 },
    )
  }
  await logHospitalAudit({ ctx, action: 'LAB_QC_MATERIAL_CREATED', tableName: 'lab_qc_materials', recordId: data.id, newValue: data })
  return NextResponse.json({ material: data }, { status: 201 })
}
