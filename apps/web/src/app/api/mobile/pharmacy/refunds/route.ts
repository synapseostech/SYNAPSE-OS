import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { reversePharmacySale } from '@synapse/db/inventory-rpc'
import { attachSaleToTill } from '@synapse/db/till-service'
import { canDo } from '../../../../../lib/capability-map'
import {
  isMobileAuth,
  isMobilePharmacyAdmin,
  requireMobilePharmacyAuth,
  type MobileAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/**
 * What the customer actually handed over for a sale, read back from the tag
 * `encodePaymentRef` wrote. A credit sale that was never paid off refunds only
 * what was received, not the sale total — the portal's refund list reports the
 * same figure. Keep this in step with
 * apps/pharmacy/lib/pos/partial-payment.ts (decodePaidAmount).
 */
function paidAmount(
  paymentRef: string | null | undefined,
  total: number | string | null | undefined,
  method: string | null | undefined,
): number {
  const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const safeTotal = round(Math.max(0, Number(total) || 0))
  const match = /PAID:([0-9]+([.][0-9]+)?)/.exec(paymentRef ?? '')
  let paid: number
  if (match) paid = Number(match[1]) || 0
  else if ((method ?? '').trim().toLowerCase() === 'credit') paid = 0
  else paid = safeTotal
  return Math.min(Math.max(round(paid), 0), safeTotal)
}

/** Mirror portal pos.refund: store managers, admins/CEO, finance. */
const REFUND_ROLES = new Set([
  'pharmacy_admin',
  'pharmacy_ceo',
  'pharmacy_store_manager',
  'finance',
])

function canRefund(auth: MobileAuth): boolean {
  if (isMobilePharmacyAdmin(auth)) return true
  if (REFUND_ROLES.has(auth.role)) return true
  return canDo(auth.role, 'pos', 'refund', 'write')
}

/** GET — list voided/refunded POS sales for this tenant. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const { data } = await db()
    .from('pharmacy_pos_sales')
    .select(
      'id, receipt_number, total_amount, payment_method, payment_ref, status, voided_reason, voided_at, created_at',
    )
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'voided')
    .order('voided_at', { ascending: false })
    .limit(50)

  return NextResponse.json({
    canRefund: canRefund(auth),
    refunds: (data ?? []).map((s: Record<string, unknown>) => ({
      id: s.id,
      receiptNumber: s.receipt_number,
      amount: paidAmount(
        s.payment_ref as string | null,
        s.total_amount as number | null,
        s.payment_method as string | null,
      ),
      totalAmount: Number(s.total_amount ?? 0),
      paymentMethod: s.payment_method,
      status: s.status ?? 'voided',
      reason: s.voided_reason ?? null,
      voidedAt: s.voided_at ?? null,
      createdAt: s.created_at,
    })),
  })
}

/**
 * POST — refund/void a completed POS sale via reversePharmacySale (batch + product restore).
 */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!canRefund(auth)) {
    return NextResponse.json(
      { error: 'Refund permission required (pos.refund)' },
      { status: 403 },
    )
  }

  const body = (await req.json().catch(() => null)) as {
    saleId?: string
    reason?: string
    restoreAs?: 'active' | 'quarantined'
  } | null

  const saleId = typeof body?.saleId === 'string' ? body.saleId.trim() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  const restoreAs = body?.restoreAs === 'active' ? 'active' : 'quarantined'

  if (!saleId) {
    return NextResponse.json({ error: 'saleId is required' }, { status: 400 })
  }
  // A void is irreversible and restocks real units, so the audit trail needs a
  // reason a person wrote — the same rule the portal refund screen applies.
  if (!reason) {
    return NextResponse.json(
      { error: 'A refund reason is required', code: 'REFUND_REASON_REQUIRED' },
      { status: 400 },
    )
  }

  const { data, error } = await reversePharmacySale(db(), {
    tenantId: auth.tenantId,
    saleId,
    actorId: auth.userId,
    reason,
    restoreAs,
  })

  if (error) {
    const status =
      error.code === 'ALREADY_REFUNDED'
        ? 409
        : error.code === 'SALE_NOT_FOUND'
          ? 404
          : error.code === 'PRODUCT_NOT_FOUND'
            ? 409
            : 400
    return NextResponse.json(
      { error: error.humanMessage, code: error.code, detail: error.message },
      { status },
    )
  }

  const refundAmount = Number((data as any)?.refund_amount ?? 0)
  const { data: saleRow } = await db()
    .from('pharmacy_pos_sales')
    .select('payment_method, cashier_id')
    .eq('id', saleId)
    .eq('tenant_id', auth.tenantId)
    .maybeSingle()
  await attachSaleToTill({
    tenantId: auth.tenantId,
    cashierId: String(saleRow?.cashier_id ?? auth.userId),
    paymentMethod: String(saleRow?.payment_method ?? 'cash'),
    amount: refundAmount,
    kind: 'refund',
    required: false,
    sourceId: `refund:${saleId}`,
  })

  return NextResponse.json({
    ok: true,
    saleId: (data as any)?.sale_id ?? saleId,
    receiptNumber: (data as any)?.receipt_number,
    refundAmount,
    // Same receivable figures the web refund screen reports, so a phone and a
    // till tell the customer the same story about their credit.
    receivableReversal: Number((data as any)?.receivable_reversal ?? 0),
    receivableOutstanding: Number((data as any)?.receivable_outstanding ?? 0),
    receivableUnreversed: Number((data as any)?.receivable_unreversed ?? 0),
    receivableUnposted: (data as any)?.receivable_unposted === true,
    creditBalanceAfter:
      (data as any)?.credit_balance_after == null ? null : Number((data as any).credit_balance_after),
    restoreAs: (data as any)?.restore_as ?? restoreAs,
    status: (data as any)?.status ?? 'voided',
  })
}
