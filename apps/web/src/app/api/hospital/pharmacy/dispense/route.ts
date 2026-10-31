import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { allocateFefo, summarizeInventory, type BatchInput } from '@synapse/db/inventory'
import { ExchangeOutbox } from '@synapse/db/exchange'
import { verifyPrescription, dispensePrescription } from '@synapse/db/prescription-bridge'
import { rowToClinicalPrescription, persistClinicalPrescriptionBestEffort } from '@synapse/db/prescription-persist'
import { persistDomainEventsBestEffort, persistWorkQueueArtifactsBestEffort } from '@synapse/db/work-queue-persist'
import { WorkQueue } from '@synapse/db/work-queue'
import { appendClinicalChargeBestEffort, recordInvoiceCreatedEvent } from '@synapse/db/clinical-charge'
import { medicationDispensedTimelineEvent, publishClinicalTimelineBestEffort } from '@synapse/db/clinical-timeline'
import { publishTimelineEvent } from '@synapse/db/identity-persist'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '@/lib/hospital-shared'
import { requireHospitalStaffContext, hospitalDispenseSchema } from '@/lib/hospital-dept'
import { runClinicalSafetyCheck } from '@/lib/clinical-safety'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'prescription', 'dispense', 'dispensing')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'dispensing')
  if (moduleBlock) return moduleBlock

  const body = await req.json().catch(() => null)
  const parsed = hospitalDispenseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { prescription_id, product_id, pharmacy_tenant_id, payment_method, safety_override_reason } =
    parsed.data

  // Hospital dispensing draws on the facility's own stock; cross-tenant network dispensing is not enabled.
  if (pharmacy_tenant_id !== ctx.tenantId) {
    return NextResponse.json({ error: 'Pharmacy not available to this facility' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row, error: loadError } = await db
    .from('clinical_prescriptions')
    .select('*')
    .eq('id', prescription_id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'Prescription not found' }, { status: 404 })

  const current = rowToClinicalPrescription(row as Record<string, unknown>)
  if (current.status === 'dispensed') {
    return NextResponse.json({ error: 'Already dispensed' }, { status: 409 })
  }

  if (current.status === 'active') {
    const verifyCap = await requireHospitalCapability(ctx, 'prescription', 'verify', 'dispensing')
    if (verifyCap) return verifyCap
  }

  const { data: product, error: productError } = await db
    .from('pharmacy_products')
    // `generic_name` and `active_ingredient` are read for the safety check: the
    // product name alone is a brand string and is the least reliable of the
    // three for matching against a drug catalogue.
    .select('id, price, name, generic_name, active_ingredient, is_active')
    .eq('id', product_id)
    .eq('tenant_id', pharmacy_tenant_id)
    .maybeSingle()

  if (productError) return NextResponse.json({ error: productError.message }, { status: 500 })
  if (!product?.is_active) {
    return NextResponse.json({ error: 'Product not found or inactive' }, { status: 400 })
  }

  // Safety runs against the product actually being handed over, not against the
  // prescription's free text: at this point the drug is a real catalogue entry.
  const safety = await runClinicalSafetyCheck({
    db,
    tenantId: ctx.tenantId,
    hospitalId: ctx.hospitalId,
    patientId: current.patientId,
    encounterId: current.encounterId,
    actorId: ctx.userId,
    stage: 'dispense',
    newDrugs: [
      {
        label: product.name,
        aliases: [product.generic_name, product.active_ingredient, current.medicationDisplay].filter(
          (value: string | null): value is string => typeof value === 'string' && value.trim().length > 0,
        ),
        productId: product.id,
        role: 'new',
      },
    ],
    overrideReason: safety_override_reason ?? null,
  })

  if (safety.decision.decision === 'block') {
    const overridden = typeof safety_override_reason === 'string' && safety_override_reason.trim().length > 0
    if (!overridden) {
      return NextResponse.json(
        {
          error: 'clinical_safety_block',
          message:
            'This dispense was stopped by a clinical safety check. Supply safety_override_reason to proceed deliberately.',
          safety: safety.payload,
          safetyAuditRecordId: safety.auditRecordId ?? null,
        },
        { status: 409 },
      )
    }
  }

  // Authoritative on-hand qty lives on pharmacy_product_batches (not a pharmacy_stock table).
  const { data: stockRows, error: stockError } = await db
    .from('pharmacy_product_batches')
    .select('id, quantity, expiry_date, status, is_active, selling_price')
    .eq('tenant_id', pharmacy_tenant_id)
    .eq('product_id', product_id)
  if (stockError) {
    return NextResponse.json({ error: stockError.message }, { status: 500 })
  }

  const inventory = summarizeInventory(
    { id: product.id, name: product.name, is_active: product.is_active },
    (stockRows ?? []) as BatchInput[],
  )
  const availableStock = inventory.sellableQuantity

  try {
    const verified =
      current.status === 'verified'
        ? current
        : verifyPrescription(current, ctx.userId, ctx.role)

    const dispensed = dispensePrescription({
      rx: verified,
      dispenserId: ctx.userId,
      role: ctx.role,
      availableStock,
    })

    const allocations = allocateFefo(
      (stockRows ?? []) as BatchInput[],
      dispensed.rx.quantity,
    )
    if (
      allocations.reduce((sum, allocation) => sum + allocation.quantity, 0) !== dispensed.rx.quantity ||
      allocations.some((allocation) => !allocation.batchId)
    ) {
      return NextResponse.json({ error: 'Batch stock changed. Refresh and retry.' }, { status: 409 })
    }

    const batchesById = new Map<string, Record<string, unknown>>(
      (stockRows ?? []).map(
        (batch: Record<string, unknown>) => [String(batch.id), batch] as const,
      ),
    )
    const saleItems = allocations.map((allocation) => {
      const batch = batchesById.get(String(allocation.batchId))
      const unitPrice = Number(batch?.selling_price ?? product.price ?? 0)
      return {
        product_id,
        batch_id: allocation.batchId,
        quantity: allocation.quantity,
        unit_price: unitPrice,
        discount_amount: 0,
      }
    })
    if (saleItems.some((item) => !Number.isFinite(item.unit_price) || item.unit_price < 0)) {
      console.error('[hospital dispense] invalid batch selling price:', { productId: product_id })
      return NextResponse.json({ error: 'Could not verify batch selling price' }, { status: 500 })
    }

    const idempotencyKey = `clinical_prescriptions:${prescription_id}`
    const { data: sale, error: saleError } = await db.rpc('complete_pharmacy_sale', {
      p_tenant_id: pharmacy_tenant_id,
      p_cashier_id: ctx.userId,
      p_items: saleItems,
      p_payment_method: payment_method,
      p_session_id: null,
      p_cart_id: null,
      p_payment_ref: null,
      p_discount_total: 0,
      p_tax_amount: 0,
      p_patient_id: dispensed.rx.patientId,
      p_confirmed_by: ctx.userId,
      p_idempotency_key: idempotencyKey,
    })

    if (saleError) {
      const code = ['INSUFFICIENT_STOCK', 'BATCH_PRICE_CHANGED', 'EXPIRED_BATCH_BLOCKED'].find(
        (candidate) => saleError.message?.includes(candidate),
      )
      return NextResponse.json(
        { error: saleError.message, ...(code ? { code } : {}) },
        { status: code ? 409 : 400 },
      )
    }

    const saleId =
      sale && typeof sale === 'object'
        ? String((sale as Record<string, unknown>).sale_id ?? (sale as Record<string, unknown>).id ?? '')
        : null

    const outbox = new ExchangeOutbox()
    outbox.append({
      eventType: 'PrescriptionVerified',
      tenantId: ctx.tenantId,
      facilityId: ctx.hospitalId,
      patientId: dispensed.rx.patientId,
      encounterId: dispensed.rx.encounterId,
      actorId: ctx.userId,
      source: 'synapse-pharm',
      aggregateId: dispensed.rx.id,
      action: 'verify',
      correlationId: dispensed.rx.correlationId,
      payload: { prescription_id: dispensed.rx.id, medication_display: dispensed.rx.medicationDisplay },
      isSynthetic: dispensed.rx.isSynthetic,
      simulationRunId: dispensed.rx.simulationRunId ?? null,
    })
    outbox.append({
      eventType: 'MedicationDispensed',
      tenantId: ctx.tenantId,
      facilityId: ctx.hospitalId,
      patientId: dispensed.rx.patientId,
      encounterId: dispensed.rx.encounterId,
      actorId: ctx.userId,
      source: 'synapse-pharm',
      aggregateId: dispensed.rx.id,
      action: 'dispense',
      correlationId: dispensed.rx.correlationId,
      payload: {
        prescription_id: dispensed.rx.id,
        product_id,
        quantity: dispensed.rx.quantity,
        sale_id: saleId,
      },
      isSynthetic: dispensed.rx.isSynthetic,
      simulationRunId: dispensed.rx.simulationRunId ?? null,
    })

    const updatedRx = {
      ...dispensed.rx,
      pharmacyTenantId: pharmacy_tenant_id,
    }
    await persistClinicalPrescriptionBestEffort(db, updatedRx)
    await db
      .from('clinical_prescriptions')
      .update({
        pharmacy_order_id: saleId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', prescription_id)
      .eq('tenant_id', ctx.tenantId)

    const { data: taskRow } = await db
      .from('department_tasks')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('source_resource', 'clinical_prescriptions')
      .eq('source_id', prescription_id)
      .eq('task_type', 'prescription')
      .maybeSingle()

    if (taskRow) {
      await db
        .from('department_tasks')
        .update({
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          result_summary: `Dispensed via sale ${saleId ?? 'unknown'}`,
        })
        .eq('id', taskRow.id)
        .eq('tenant_id', ctx.tenantId)
    }

    await persistDomainEventsBestEffort(db, outbox.list({ correlationId: dispensed.rx.correlationId }))

    let dispenseCharge: { invoiceId: string; created: boolean; totalAmount: number } | null = null
    let invoiceCreated = false
    for (const item of saleItems) {
      const charge = await appendClinicalChargeBestEffort(db, {
        tenantId: ctx.tenantId,
        patientId: dispensed.rx.patientId,
        encounterId: dispensed.rx.encounterId,
        itemName: `Dispense · ${dispensed.rx.medicationDisplay}`,
        unitPrice: item.unit_price,
        qty: item.quantity,
        sourceTable: 'pharmacy_dispense',
        sourceId: `${prescription_id}:${item.batch_id}`,
      })
      if (charge.ok) {
        dispenseCharge = charge.result
        invoiceCreated ||= charge.result.created
      }
    }

    if (dispenseCharge) {
      if (invoiceCreated) {
        const invoiceOutbox = recordInvoiceCreatedEvent({
          tenantId: ctx.tenantId,
          hospitalId: ctx.hospitalId,
          patientId: dispensed.rx.patientId,
          encounterId: dispensed.rx.encounterId,
          invoiceId: dispenseCharge.invoiceId,
          totalAmount: dispenseCharge.totalAmount,
          actorId: ctx.userId,
        })
        await persistDomainEventsBestEffort(db, invoiceOutbox.list({ correlationId: dispensed.rx.correlationId }))
      }

      const { data: invoice } = await db
        .from('billing_invoices')
        .select('id, total_amount, paid_amount, status')
        .eq('id', dispenseCharge.invoiceId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle()
      const balanceDue = Math.max(0, Number(invoice?.total_amount ?? 0) - Number(invoice?.paid_amount ?? 0))
      if (balanceDue > 0 && invoice?.status !== 'paid') {
        const queue = new WorkQueue()
        const billingTask = queue.create({
          tenantId: ctx.tenantId,
          facilityId: ctx.hospitalId,
          hospitalId: ctx.hospitalId,
          patientId: dispensed.rx.patientId,
          encounterId: dispensed.rx.encounterId,
          requesterId: ctx.userId,
          ownerDepartment: 'billing',
          ownerRole: 'cashier',
          taskType: 'billing',
          priority: 'ROUTINE',
          title: 'Payment required',
          description: `Invoice balance due: ${balanceDue}`,
          sourceResource: 'billing_invoices',
          sourceId: dispenseCharge.invoiceId,
          correlationId: dispensed.rx.correlationId,
          idempotencyKey: `billing_invoices:${dispenseCharge.invoiceId}:payment`,
          suppressDomainEvent: true,
        })
        if (billingTask.ok) {
          const billingPersist = await persistWorkQueueArtifactsBestEffort(db, {
            tasks: [billingTask.task],
            events: [],
          })
          if (billingPersist.errors.length) {
            console.warn('[hospital/dispense] billing handoff persist partial', billingPersist.errors)
          }
        }
      }
    }

    void publishClinicalTimelineBestEffort(
      publishTimelineEvent,
      medicationDispensedTimelineEvent({
        tenantId: ctx.tenantId,
        hospitalId: ctx.hospitalId,
        patientId: dispensed.rx.patientId,
        prescriptionId: dispensed.rx.id,
        encounterId: dispensed.rx.encounterId,
        medicationDisplay: dispensed.rx.medicationDisplay,
        quantity: dispensed.rx.quantity,
        saleId,
        dispensedBy: ctx.userId,
      }),
    )

    await logHospitalAudit({
      ctx,
      action: 'UPDATE',
      tableName: 'clinical_prescriptions',
      recordId: prescription_id,
      newValue: { status: 'dispensed', sale_id: saleId, product_id },
    })

    return NextResponse.json({
      prescription: updatedRx,
      sale,
      remainingStock: dispensed.remainingStock,
      safety: safety.payload,
      safetyAuditRecordId: safety.auditRecordId ?? null,
      safetyAuditError: safety.auditError ?? null,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Dispense failed' },
      { status: 400 },
    )
  }
}
