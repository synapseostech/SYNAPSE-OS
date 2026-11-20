import 'server-only'

import { appendClinicalChargeBestEffort, recordInvoiceCreatedEvent, resolveServicePrice } from '@synapse/db/clinical-charge'
import { persistDomainEventsBestEffort } from '@synapse/db/work-queue-persist'
import type { LabEngineContext } from './engine'

export type LabChargeLine = {
  orderId: string
  testName: string
  price: number | null
}

export type LabChargeOutcome = {
  invoiceId: string | null
  total: number
  charged: string[]
  unpriced: string[]
  warnings: string[]
}

/**
 * Bill laboratory tests to the visit's invoice. The catalogue price wins;
 * without one, the hospital's `service_catalog` (service_type 'lab') is tried,
 * the same lookup the OPD order route uses. A test with neither is not billed
 * and is listed in `unpriced`, so the desk can see what to price.
 * appendClinicalCharge is idempotent per (lab_orders, order id), so a retry
 * never bills twice.
 */
export async function chargeLabOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ctx: LabEngineContext,
  params: { patientId: string; encounterId: string; lines: LabChargeLine[] },
): Promise<LabChargeOutcome> {
  const outcome: LabChargeOutcome = { invoiceId: null, total: 0, charged: [], unpriced: [], warnings: [] }
  let invoiceCreated = false
  for (const line of params.lines) {
    const price = line.price ?? await resolveServicePrice(db, ctx.tenantId, 'lab', line.testName)
    if (price == null) {
      outcome.unpriced.push(line.testName)
      continue
    }
    const charge = await appendClinicalChargeBestEffort(db, {
      tenantId: ctx.tenantId,
      patientId: params.patientId,
      encounterId: params.encounterId,
      itemName: `Lab · ${line.testName}`,
      unitPrice: price,
      sourceTable: 'lab_orders',
      sourceId: line.orderId,
      createdBy: null,
    })
    if (!charge.ok) {
      outcome.warnings.push(`LAB_CHARGE_FAILED:${line.testName}:${charge.error}`)
      continue
    }
    outcome.invoiceId = charge.result.invoiceId
    outcome.total = charge.result.totalAmount
    outcome.charged.push(line.orderId)
    if (charge.result.created) invoiceCreated = true
  }
  if (invoiceCreated && outcome.invoiceId) {
    const outbox = recordInvoiceCreatedEvent({
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      patientId: params.patientId,
      encounterId: params.encounterId,
      invoiceId: outcome.invoiceId,
      totalAmount: outcome.total,
      actorId: ctx.userId,
    })
    const persisted = await persistDomainEventsBestEffort(db, outbox.list({ correlationId: params.encounterId }))
    if (!persisted.ok) outcome.warnings.push(persisted.error)
  }
  return outcome
}
