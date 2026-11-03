import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  isReceiptPrintSaleId,
  parseReceiptPrintOutcome,
  recordReceiptPrintOutcome,
} from "@/lib/pos/receipt-print"

const db = () => supabaseAdmin as any

/**
 * POST /api/admin/pos/sales/[id]/print-status
 *
 * Records the outcome of the receipt print step for a completed POS sale.
 *
 * `requested` records that the cashier asked to print, not that a dialog
 * opened or that paper came out — the browser cannot attest to either. It never
 * writes `printed_at`, which would imply a confirmed print. `failed` records a
 * cashier-reported failure.
 *
 * This is deliberately not a financial write: it never touches totals,
 * payments, stock or the sale's status, so a reprint or a failed print cannot
 * duplicate or reverse a sale.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // A non-uuid reaches Postgres as a cast error and would surface as a 500.
    if (!isReceiptPrintSaleId(id)) {
      return NextResponse.json(
        { error: "Invalid sale id", code: "INVALID_SALE_ID" },
        { status: 400 },
      )
    }
    const auth = await requirePharmacyPermission("pos.sell")
    if (!auth.ok) return auth.response
    const { tenantId, session } = auth

    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    const outcome = parseReceiptPrintOutcome(body?.outcome)
    if (!outcome) {
      return NextResponse.json(
        { error: "outcome must be 'requested' or 'failed'", code: "INVALID_PRINT_OUTCOME" },
        { status: 400 },
      )
    }

    const result = await recordReceiptPrintOutcome(db(), {
      tenantId,
      profileId: session.user.id,
      saleId: id,
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
    console.error("Record receipt print status error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
