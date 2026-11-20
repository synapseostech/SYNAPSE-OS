import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '../../../../../../lib/hospital-shared'
import { requireHospitalStaffContext } from '../../../../../../lib/hospital-dept'
import { loadInvoice, loadInvoiceLinesAndPayments, patientBalance } from '../../../../../../lib/hospital-billing'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Cashier view of one invoice: lines, payments, patient and the patient's active insurance policies. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'invoice', 'read', 'billing')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'billing')
  if (moduleBlock) return moduleBlock

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { invoice, error } = await loadInvoice(db, ctx.tenantId, { invoiceId: id })
  if (error) return NextResponse.json({ error: 'Could not load invoice' }, { status: 500 })
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  const [detail, patient, policies] = await Promise.all([
    loadInvoiceLinesAndPayments(db, ctx.tenantId, invoice.id),
    invoice.patient_id
      ? db.from('patients').select('id, full_name, mrn, phone').eq('id', invoice.patient_id).eq('tenant_id', ctx.tenantId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    invoice.patient_id
      ? db
          .from('insurance_policies')
          .select('id, payer_id, policy_number, member_id, plan_name, expiry_date, status')
          .eq('tenant_id', ctx.tenantId)
          .eq('patient_id', invoice.patient_id)
          .eq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (detail.error) return NextResponse.json({ error: 'Could not load invoice' }, { status: 500 })

  const payerIds = [...new Set(((policies.data ?? []) as Array<{ payer_id: string | null }>).map((p) => p.payer_id).filter(Boolean))]
  const { data: payers } = payerIds.length
    ? await db.from('insurance_providers').select('id, name').eq('tenant_id', ctx.tenantId).in('id', payerIds)
    : { data: [] }
  const payerName = new Map(((payers ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]))

  return NextResponse.json({
    invoice: { ...invoice, balance_due: patientBalance(invoice) },
    lineItems: detail.lineItems,
    payments: detail.payments,
    patient: patient.data
      ? { id: patient.data.id, fullName: patient.data.full_name, mrn: patient.data.mrn, phone: patient.data.phone ?? null }
      : null,
    policies: ((policies.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: p.id,
      insurerName: (p.payer_id && payerName.get(String(p.payer_id))) || p.plan_name || 'Insurer',
      memberNumber: p.member_id ?? p.policy_number,
      scheme: p.plan_name ?? null,
      expiryDate: p.expiry_date ?? null,
    })),
  })
}
