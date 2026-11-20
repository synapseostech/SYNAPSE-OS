import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { LabWorkflow } from '@synapse/db/lab-workflow'
import { rowToLabOrder, persistLabOrderBestEffort } from '@synapse/db/lab-order-persist'
import { WorkQueue } from '@synapse/db/work-queue'
import { rowToDepartmentTask, persistWorkQueueArtifactsBestEffort } from '@synapse/db/work-queue-persist'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { clinicalActionTimelineEvent, publishClinicalTimelineBestEffort } from '@synapse/db/clinical-timeline'
import { publishTimelineEvent } from '@synapse/db/identity-persist'
import { voidClinicalCharge } from '@synapse/db/clinical-charge'

export const dynamic = 'force-dynamic'
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // lab.order.cancel did not exist before 20261121093700, so this route
  // refused everyone; the migration grants it to scientists, lab admins and
  // the ordering clinicians.
  const ctx = await requireLabAccess('order.cancel'); if (isLabContextError(ctx)) return ctx
  const body = await req.json().catch(() => null) as { reason?: string } | null
  if (!body?.reason?.trim()) return NextResponse.json({ error: 'Cancellation reason is required' }, { status: 400 })
  const { id } = await params; if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Lab order not found' }, { status: 404 }); const db = supabaseAdmin as any
  const { data: row, error } = await db.from('lab_orders').select('*').eq('id', id).eq('tenant_id', ctx.tenantId).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'Lab order not found' }, { status: 404 })
  const order = rowToLabOrder(row)
  const warnings: string[] = []
  const voidCharge = async () => {
    if (!order.encounterId) return false
    try {
      const charge = await voidClinicalCharge(db, { tenantId: ctx.tenantId, encounterId: order.encounterId, sourceTable: 'lab_orders', sourceId: id })
      if (charge.reason === 'INVOICE_LOCKED') warnings.push('LAB_CHARGE_ON_SETTLED_INVOICE:refund_or_credit_required')
      return charge.voided
    } catch (voidError) {
      warnings.push(`LAB_CHARGE_VOID_FAILED:${voidError instanceof Error ? voidError.message : 'unknown'}`)
      return false
    }
  }
  if (order.status === 'CANCELLED') {
    // Retrying a cancel re-attempts the void so a failed first attempt cannot leave the charge billed.
    const chargeVoided = await voidCharge()
    return NextResponse.json({ orderId: id, cancelled: true, alreadyCancelled: true, chargeVoided, ...(warnings.length ? { warnings } : {}) })
  }
  const lab = new LabWorkflow([order])
  let cancelledOrder
  try {
    cancelledOrder = lab.transition(id, 'CANCELLED', { rejectionNote: body.reason.trim() })
  } catch (transitionError) {
    return NextResponse.json({ error: 'This Lab order can no longer be cancelled', detail: transitionError instanceof Error ? transitionError.message : 'illegal transition' }, { status: 409 })
  }
  const at = new Date().toISOString()
  const persisted = await persistLabOrderBestEffort(db, { ...cancelledOrder, rejectionNote: body.reason.trim() })
  if (!persisted.ok) return NextResponse.json({ error: persisted.error }, { status: 500 })
  await db.from('lab_orders').update({ cancellation_reason: body.reason.trim(), cancelled_by: ctx.userId, cancelled_at: at }).eq('id', id).eq('tenant_id', ctx.tenantId)
  const { data: taskRows } = await db.from('department_tasks').select('*').eq('tenant_id', ctx.tenantId).eq('source_resource', 'lab_orders').eq('source_id', id).in('status', ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD'])
  const queue = new WorkQueue(); const tasks = []
  for (const taskRow of taskRows ?? []) { const task = rowToDepartmentTask(taskRow); queue.tasks.set(task.id, task); const cancelled = queue.cancel(task.id, `Lab order cancelled: ${body.reason.trim()}`); if (cancelled.ok) tasks.push(cancelled.task) }
  if (tasks.length) await persistWorkQueueArtifactsBestEffort(db, { tasks, events: [] })
  const chargeVoided = await voidCharge()
  await logHospitalAudit({ ctx, action: 'LAB_ORDER_CANCELLED', tableName: 'lab_orders', recordId: id, newValue: { status: 'CANCELLED', reason: body.reason.trim(), chargeVoided } })
  void publishClinicalTimelineBestEffort(publishTimelineEvent, clinicalActionTimelineEvent({ tenantId: ctx.tenantId, hospitalId: ctx.hospitalId, patientId: order.patientId, encounterId: order.encounterId, sourceTable: 'lab_orders', sourceId: id, title: 'Lab order cancelled', summary: body.reason.trim(), createdBy: ctx.userId, tags: ['laboratory', 'cancelled'] }))
  return NextResponse.json({ orderId: id, cancelled: true, cancelledAt: at, chargeVoided, ...(warnings.length ? { warnings } : {}) })
}