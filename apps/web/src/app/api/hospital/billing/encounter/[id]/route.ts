import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { materializeEncounterCharges } from '@synapse/db/clinical-charge'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'
import { loadInvoice, loadInvoiceLinesAndPayments, patientBalance } from '../../../../../../lib/hospital-billing'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'invoice', 'read', 'billing')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'billing')
  if (moduleBlock) return moduleBlock

  const { id: encounterId } = await params

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const materialized = await materializeEncounterCharges(db, {
    tenantId: ctx.tenantId,
    encounterId,
  })
  if (!materialized.encounterFound) {
    return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })
  }

  const { invoice, error: invoiceError } = await loadInvoice(db, ctx.tenantId, { encounterId })
  if (invoiceError) return NextResponse.json({ error: invoiceError }, { status: 500 })
  if (!invoice) {
    return NextResponse.json({ invoice: null, lineItems: [], payments: [], warnings: materialized.warnings })
  }

  const detail = await loadInvoiceLinesAndPayments(db, ctx.tenantId, invoice.id)
  if (detail.error) return NextResponse.json({ error: detail.error }, { status: 500 })
  const { lineItems, payments } = detail

  return NextResponse.json({
    invoice: { ...invoice, balance_due: patientBalance(invoice) },
    lineItems,
    payments,
    warnings: materialized.warnings,
  })
}
