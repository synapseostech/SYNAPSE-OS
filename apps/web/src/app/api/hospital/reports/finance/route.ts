import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError, requireHospitalCapability } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'
import { buildFinanceDashboard } from '../../../../../lib/hospital-reports/finance'

export const dynamic = 'force-dynamic'

const UTC_OFFSET_MS = 3 * 3_600_000
const CAP = 20_000
const CHUNK = 400

function bounds(period: string) {
  if (!/^\d{6}$/.test(period)) return null
  const y = Number(period.slice(0, 4))
  const m = Number(period.slice(4, 6)) - 1
  if (m < 0 || m > 11 || y < 2000 || y > 2100) return null
  return {
    start: new Date(Date.UTC(y, m, 1) - UTC_OFFSET_MS).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1) - UTC_OFFSET_MS).toISOString(),
  }
}

/**
 * Finance for the facility admin: billed, collected (by method), patient
 * balances and insurance receivables with ageing, denials and top services.
 * ?period=YYYYMM (default this month). reports.generate.read; tenant-scoped.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, 'generate', 'read', 'reports')
  if (cap) return cap

  const d = new Date(Date.now() + UTC_OFFSET_MS)
  const period = req.nextUrl.searchParams.get('period') ?? `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  const range = bounds(period)
  if (!range) return NextResponse.json({ error: 'period must be YYYYMM' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const invoiceCols = 'id, status, total_amount, paid_amount, insurance_cover_amount, currency, created_at'
  const [periodInv, openInv, payments, claims] = await Promise.all([
    db.from('billing_invoices').select(invoiceCols).eq('tenant_id', ctx.tenantId).eq('is_deleted', false)
      .gte('created_at', range.start).lt('created_at', range.end).limit(CAP),
    // Older invoices still owing, for patient-balance ageing.
    db.from('billing_invoices').select(invoiceCols).eq('tenant_id', ctx.tenantId).eq('is_deleted', false)
      .lt('created_at', range.start).in('status', ['issued', 'partially_paid']).limit(CAP),
    db.from('billing_payments').select('amount, currency, payment_method, created_at').eq('tenant_id', ctx.tenantId).eq('is_deleted', false)
      .gte('created_at', range.start).lt('created_at', range.end).limit(CAP),
    db.from('insurance_claims').select('insurer_name, status, billed_amount, paid_amount, submitted_at, paid_at, denial_reason, denial_code')
      .eq('tenant_id', ctx.tenantId).eq('is_deleted', false).neq('status', 'void').limit(CAP),
  ])
  if (periodInv.error || openInv.error || payments.error || claims.error) {
    return NextResponse.json({ error: 'Could not load billing data' }, { status: 500 })
  }

  const ids = (periodInv.data ?? []).map((i: { id: string }) => i.id)
  const lines: unknown[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db.from('billing_line_items').select('invoice_id, item_name, total_price')
      .eq('tenant_id', ctx.tenantId).eq('is_deleted', false).in('invoice_id', ids.slice(i, i + CHUNK))
    if (error) return NextResponse.json({ error: 'Could not load invoice lines' }, { status: 500 })
    lines.push(...(data ?? []))
  }

  const dashboard = buildFinanceDashboard({
    invoices: [...(periodInv.data ?? []), ...(openInv.data ?? [])],
    lines: lines as never,
    payments: payments.data ?? [],
    claims: claims.data ?? [],
    period: range,
  })
  const truncated = [periodInv, openInv, payments, claims].some((r) => (r.data ?? []).length >= CAP)
  return NextResponse.json({ ...dashboard, periodKey: period, truncated }, { headers: { 'Cache-Control': 'private, no-store' } })
}
