import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { qcCorrectiveActionSchema } from '@/lib/lab/qc'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Write what was done about a rejected run (recalibrated, new reagent, fresh
 * control vial…). Written once: the record of the failure is not edited later.
 * It does not lift the lock by itself; a passing rerun does.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('qc.record')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  const parsed = qcCorrectiveActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db
    .from('lab_qc_runs')
    .update({ corrective_action: parsed.data.action, corrected_by: ctx.userId, corrected_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'rejected')
    .is('corrective_action', null)
    .select('id, material_id, status, corrective_action, corrected_at')
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not save the corrective action' }, { status: 500 })
  if (!data) {
    const { data: run } = await db.from('lab_qc_runs').select('id, status, corrective_action').eq('id', id).eq('tenant_id', ctx.tenantId).maybeSingle()
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    return NextResponse.json(
      { error: run.status !== 'rejected' ? 'Only a rejected run needs a corrective action' : 'A corrective action is already recorded for this run' },
      { status: 409 },
    )
  }
  await logHospitalAudit({ ctx, action: 'LAB_QC_CORRECTIVE_ACTION', tableName: 'lab_qc_runs', recordId: id, newValue: { action: parsed.data.action } })
  return NextResponse.json({ run: data })
}
