import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '../../../../../lib/hospital-shared'
import { requireHospitalStaffContext, cashierListSchema } from '../../../../../lib/hospital-dept'
import { patientBalance } from '../../../../../lib/hospital-billing'

export const dynamic = 'force-dynamic'

const OPEN_STATUSES = ['draft', 'issued', 'partially_paid']

type Row = {
  id: string
  invoice_number: string | null
  status: string
  currency: string
  total_amount: number
  paid_amount: number
  insurance_cover_amount?: number | null
  encounter_id: string | null
  patient_id: string | null
  created_at: string
  patients?: { full_name: string | null; mrn: string | null } | null
}

/**
 * Cashier queue: invoices of the caller's tenant, newest first, one page per
 * call (keyset on created_at, `before` = last row's created_at). One query,
 * patient name embedded.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'invoice', 'read', 'billing')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'billing')
  if (moduleBlock) return moduleBlock

  const parsed = cashierListSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const { status, limit, before } = parsed.data

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const build = (insurance: boolean) => {
    let q = db
      .from('billing_invoices')
      .select(
        `id, invoice_number, status, currency, total_amount, paid_amount, ${insurance ? 'insurance_cover_amount, ' : ''}encounter_id, patient_id, created_at, patients(full_name, mrn)`,
      )
      .eq('tenant_id', ctx.tenantId)
      .eq('is_deleted', false)
      .gt('total_amount', 0)
    if (status === 'open') q = q.in('status', OPEN_STATUSES)
    if (status === 'paid') q = q.eq('status', 'paid')
    if (before) q = q.lt('created_at', before)
    return q.order('created_at', { ascending: false }).limit(limit + 1)
  }

  let { data, error } = await build(true)
  if (error && (error.code === '42703' || error.code === 'PGRST204')) ({ data, error } = await build(false))
  if (error) return NextResponse.json({ error: 'Could not load invoices' }, { status: 500 })

  const rows = (data ?? []) as Row[]
  const page = rows.slice(0, limit)
  return NextResponse.json({
    invoices: page.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      status: r.status,
      currency: r.currency,
      totalAmount: Number(r.total_amount),
      paidAmount: Number(r.paid_amount),
      insuranceCover: Number(r.insurance_cover_amount ?? 0),
      balanceDue: patientBalance(r),
      encounterId: r.encounter_id,
      patientId: r.patient_id,
      patientName: r.patients?.full_name ?? null,
      mrn: r.patients?.mrn ?? null,
      createdAt: r.created_at,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1]?.created_at ?? null : null,
  })
}
