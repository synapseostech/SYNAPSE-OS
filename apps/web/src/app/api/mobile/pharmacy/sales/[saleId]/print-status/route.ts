import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  isReceiptPrintSaleId,
  parseReceiptPrintOutcome,
  recordReceiptPrintOutcome,
} from '@synapse/db/receipt-print'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/**
 * POST /api/mobile/pharmacy/sales/[saleId]/print-status
 *
 * The phone counterpart of /api/admin/pos/sales/[id]/print-status: it records
 * the same `requested` / `failed` outcome, in the same columns and audit rows,
 * so a print that fails on the phone is visible from the web till and vice
 * versa. A phone cannot prove paper came out either — React Native's
 * `Print.printAsync` resolves when the OS print sheet is dismissed — so the
 * response never claims the receipt printed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ saleId: string }> },
) {
  try {
    const { saleId } = await params
    if (!isReceiptPrintSaleId(saleId)) {
      return NextResponse.json(
        { error: 'Invalid sale id', code: 'INVALID_SALE_ID' },
        { status: 400 },
      )
    }

    const auth = await requireMobilePharmacyAuth(req)
    if (!isMobileAuth(auth)) return auth
    if (!mobileHasPharmacyCapability(auth, 'pos.sell')) {
      return NextResponse.json(
        { error: 'pos.sell capability required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    const body = (await req.json().catch(() => null)) as
      | { outcome?: unknown; reason?: unknown }
      | null
    const outcome = parseReceiptPrintOutcome(body?.outcome)
    if (!outcome) {
      return NextResponse.json(
        { error: "outcome must be 'requested' or 'failed'", code: 'INVALID_PRINT_OUTCOME' },
        { status: 400 },
      )
    }

    const result = await recordReceiptPrintOutcome(db(), {
      tenantId: auth.tenantId,
      profileId: auth.userId,
      saleId,
      outcome,
      reason: body?.reason,
    })

    if (!result.ok) {
      const failure: Record<string, unknown> = { error: result.error, code: result.code }
      if (result.attemptRecorded) {
        failure.attemptRecorded = true
        failure.outcome = result.outcome
      }
      return NextResponse.json(failure, { status: result.status })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Record mobile receipt print status error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
