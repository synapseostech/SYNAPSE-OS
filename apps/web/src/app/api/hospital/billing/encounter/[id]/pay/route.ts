import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  recordEncounterPayment,
  recordPaymentRecordedEvent,
} from '@synapse/db/clinical-payment'
import { paymentRecordedTimelineEvent, publishClinicalTimelineBestEffort } from '@synapse/db/clinical-timeline'
import { publishTimelineEvent } from '@synapse/db/identity-persist'
import { persistDomainEventsBestEffort, rowToDepartmentTask } from '@synapse/db/work-queue-persist'
import { WorkQueue } from '@synapse/db/work-queue'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '@/lib/hospital-shared'
import { requireHospitalStaffContext, encounterPaymentSchema, isMissingRpc, rpcDomainError } from '@/lib/hospital-dept'

type PaymentResult = Awaited<ReturnType<typeof recordEncounterPayment>> & {
  patientId?: string | null
  insuranceCover?: number
  billingTaskCompleted?: boolean
}

/**
 * One transaction: lock the invoice, honour the idempotency key, take the
 * next receipt number and close the billing task when settled.
 * Returns null when the migration that adds the RPC is not applied yet.
 */
async function recordPaymentAtomically(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: {
    tenantId: string
    encounterId: string
    amount: number
    paymentMethod: string
    paymentRef: string | null
    idempotencyKey: string | null
    actorId: string
    notes: string | null
  },
): Promise<PaymentResult | null> {
  const { data, error } = await db.rpc('hospital_record_payment', {
    p_tenant_id: input.tenantId,
    p_encounter_id: input.encounterId,
    p_amount: input.amount,
    p_payment_method: input.paymentMethod,
    p_actor_id: input.actorId,
    p_payment_ref: input.paymentRef,
    p_idempotency_key: input.idempotencyKey,
    p_notes: input.notes,
  })
  if (error) {
    if (isMissingRpc(error)) return null
    const mapped = rpcDomainError(error)
    throw new Error(mapped.status === 500 ? 'payment_failed' : mapped.code)
  }
  const row = data as Record<string, unknown>
  return {
    paymentId: String(row.paymentId),
    invoiceId: String(row.invoiceId),
    receiptNumber: String(row.receiptNumber ?? ''),
    amount: Number(row.amount),
    paidAmount: Number(row.paidAmount),
    totalAmount: Number(row.totalAmount),
    balanceDue: Number(row.balanceDue),
    status: String(row.status),
    created: Boolean(row.created),
    patientId: row.patientId ? String(row.patientId) : null,
    insuranceCover: Number(row.insuranceCover ?? 0),
    billingTaskCompleted: Boolean(row.billingTaskCompleted),
  }
}

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'payment', 'record', 'billing')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'billing')
  if (moduleBlock) return moduleBlock

  const { id: encounterId } = await params
  const body = await req.json().catch(() => null)
  const parsed = encounterPaymentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  try {
    const atomic = await recordPaymentAtomically(db, {
      tenantId: ctx.tenantId,
      encounterId,
      amount: parsed.data.amount,
      paymentMethod: parsed.data.payment_method,
      paymentRef: parsed.data.payment_ref ?? null,
      idempotencyKey: parsed.data.idempotency_key ?? null,
      actorId: ctx.userId,
      notes: parsed.data.notes ?? null,
    })
    const result: PaymentResult = atomic ?? await recordEncounterPayment(db, {
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      encounterId,
      amount: parsed.data.amount,
      paymentMethod: parsed.data.payment_method,
      paymentRef: parsed.data.payment_ref ?? null,
      idempotencyKey: parsed.data.idempotency_key ?? null,
      receivedBy: ctx.userId,
      notes: parsed.data.notes ?? null,
    })

    if (result.created) {
      let patientId = result.patientId ?? null
      if (!atomic) {
        const { data: invoiceRow } = await db
          .from('billing_invoices')
          .select('patient_id')
          .eq('id', result.invoiceId)
          .eq('tenant_id', ctx.tenantId)
          .maybeSingle()
        patientId = invoiceRow?.patient_id ? String(invoiceRow.patient_id) : null
      }
      const outbox = recordPaymentRecordedEvent({
        tenantId: ctx.tenantId,
        hospitalId: ctx.hospitalId,
        patientId,
        encounterId,
        invoiceId: result.invoiceId,
        paymentId: result.paymentId,
        amount: result.amount,
        paymentMethod: parsed.data.payment_method,
        receiptNumber: result.receiptNumber,
        actorId: ctx.userId,
      })
      await persistDomainEventsBestEffort(db, outbox.list({ correlationId: encounterId }))

      if (patientId) {
        void publishClinicalTimelineBestEffort(
          publishTimelineEvent,
          paymentRecordedTimelineEvent({
            tenantId: ctx.tenantId,
            hospitalId: ctx.hospitalId,
            patientId,
            encounterId,
            paymentId: result.paymentId,
            amount: result.amount,
            receiptNumber: result.receiptNumber,
            paymentMethod: parsed.data.payment_method,
            createdBy: ctx.userId,
          }),
        )
      }

      await logHospitalAudit({
        ctx,
        action: 'INSERT',
        tableName: 'billing_payments',
        recordId: result.paymentId,
        newValue: {
          invoice_id: result.invoiceId,
          amount: result.amount,
          receipt_number: result.receiptNumber,
        },
      })
    }

    // The RPC already closed the billing task in its transaction.
    if (!atomic && result.balanceDue <= 0) {
      const { data: billingTaskRow } = await db
        .from('department_tasks')
        .select('*')
        .eq('tenant_id', ctx.tenantId)
        .eq('encounter_id', encounterId)
        .eq('source_resource', 'billing_invoices')
        .eq('source_id', result.invoiceId)
        .eq('task_type', 'billing')
        .maybeSingle()
      if (billingTaskRow) {
        const queue = new WorkQueue()
        const task = rowToDepartmentTask(billingTaskRow)
        queue.tasks.set(task.id, task)
        if (task.status === 'REQUESTED') queue.start(task.id, ctx.userId)
        if (queue.get(task.id)?.status === 'IN_PROGRESS') queue.complete(task.id, 'Invoice fully paid', ctx.userId)
        const completed = queue.get(task.id)
        if (completed?.status === 'COMPLETED') {
          await db
            .from('department_tasks')
            .update({
              status: completed.status,
              accepted_at: completed.acceptedAt,
              completed_at: completed.completedAt,
              assigned_to: completed.assignedTo,
              result_summary: completed.resultSummary,
              updated_at: completed.updatedAt,
            })
            .eq('id', task.id)
            .eq('tenant_id', ctx.tenantId)
        }
      }
    }

    return NextResponse.json({ payment: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'payment_failed'
    const status =
      message === 'INVOICE_NOT_FOUND'
        ? 404
        : message === 'payment_failed'
          ? 500
          : message === 'INVOICE_ALREADY_PAID' || message === 'AMOUNT_EXCEEDS_BALANCE' || message === 'INVOICE_VOID'
          ? 409
          : 400
    return NextResponse.json({ error: message }, { status })
  }
}
