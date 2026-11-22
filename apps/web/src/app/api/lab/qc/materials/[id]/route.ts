import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { qcMaterialPatchSchema, qcMaterialToRow } from '@/lib/lab/qc'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLUMNS = 'id, loinc_code, analyte_name, unit, material_name, lot_number, level, target_mean, target_sd, expires_on, device_id, is_active, last_run_at, last_run_status, updated_at'

/**
 * Change a control's targets or expiry, or switch it off. Runs already saved
 * keep the mean and SD they were judged against. Switching off a control whose
 * last run was rejected lifts the release lock it holds, so it is audited with
 * the status it had.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('qc.manage')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Control not found' }, { status: 404 })
  const parsed = qcMaterialPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const patch = qcMaterialToRow(parsed.data)
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  if (parsed.data.deviceId) {
    const { data: device } = await db.from('lab_devices').select('id').eq('id', parsed.data.deviceId).eq('tenant_id', ctx.tenantId).maybeSingle()
    if (!device) return NextResponse.json({ error: 'Analyser not found' }, { status: 400 })
  }
  const { data: before } = await db.from('lab_qc_materials').select(COLUMNS).eq('id', id).eq('tenant_id', ctx.tenantId).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Control not found' }, { status: 404 })
  const { data, error } = await db
    .from('lab_qc_materials')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .select(COLUMNS)
    .maybeSingle()
  if (error) {
    const duplicate = /duplicate|unique/i.test(error.message ?? '')
    return NextResponse.json({ error: duplicate ? 'Another active control already uses that level and lot' : 'Could not save the control' }, { status: duplicate ? 409 : 500 })
  }
  if (!data) return NextResponse.json({ error: 'Control not found' }, { status: 404 })
  await logHospitalAudit({
    ctx,
    action: patch.is_active === false && before.last_run_status === 'rejected' ? 'LAB_QC_LOCK_RELEASED_BY_DEACTIVATION' : 'LAB_QC_MATERIAL_UPDATED',
    tableName: 'lab_qc_materials',
    recordId: id,
    oldValue: before,
    newValue: patch,
  })
  return NextResponse.json({ material: data })
}
