import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { mapRefund } from "@/lib/api-serialize"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { reversePharmacySale } from "@synapse/db/inventory-rpc"
import { attachSaleToTill } from "@/lib/pos/till-service"
import { decodePaidAmount } from "@/lib/pos/partial-payment"
import { allocateRefundAmount } from "@/lib/pos/refund-amount"
import { isTallyMirrorNote } from "@/lib/tally/types"

const db = () => supabaseAdmin as any

// GET - List refunds (voided POS sales + REFUNDED order txs)
export async function GET(_request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("pos.refund")
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const [{ data: posVoids }, { data: orderRefunds, error }] = await Promise.all([
      db()
        .from("pharmacy_pos_sales")
        .select(
          `
          id, receipt_number, total_amount, payment_method, payment_ref, cashier_id, status,
          voided_reason, voided_at, updated_at, created_at,
          items:pharmacy_pos_sale_items (
            id, quantity, unit_price, product_id, product:pharmacy_products ( name, sku )
          )
        `,
        )
        .eq("tenant_id", tenantId)
        .eq("status", "voided")
        .order("updated_at", { ascending: false }),
      db()
        .from("pharmacy_transactions")
        .select(
          `
          *,
          cashier:profiles!pharmacy_transactions_cashier_id_fkey ( full_name ),
          customer:pharmacy_customers ( name ),
          items:pharmacy_transaction_items (
            *,
            product:pharmacy_products ( name, sku )
          )
        `,
        )
        .eq("tenant_id", tenantId)
        .eq("status", "REFUNDED")
        .order("updated_at", { ascending: false }),
    ])

    if (error) {
      console.error("Get refunds error:", error)
      return NextResponse.json({ error: "Failed to fetch refunds" }, { status: 500 })
    }

    const cashierIds = new Set<string>()
    for (const s of posVoids ?? []) {
      if (s.cashier_id) cashierIds.add(s.cashier_id)
    }
    const cashierNames = new Map<string, string>()
    if (cashierIds.size > 0) {
      const { data: profiles } = await db()
        .from("profiles")
        .select("id, full_name, first_name, last_name")
        .in("id", Array.from(cashierIds))
      for (const p of profiles ?? []) {
        cashierNames.set(
          p.id,
          p.full_name ||
            [p.first_name, p.last_name].filter(Boolean).join(" ") ||
            "Unknown",
        )
      }
    }

    // The refund list reports money handed back, which for a credit sale is
    // only what the customer had actually paid — not the sale total.
    const mappedPos = (posVoids ?? []).map((s: Record<string, unknown>) =>
      mapRefund({
        ...s,
        transaction_no: s.receipt_number,
        net_amount: decodePaidAmount({
          paymentRef: s.payment_ref as string | null,
          total: s.total_amount as number | null,
          method: s.payment_method as string | null,
        }),
        notes: s.voided_reason,
        created_at: s.voided_at ?? s.updated_at ?? s.created_at,
        status: "REFUNDED",
        source: "pos",
        user: { name: cashierNames.get(String(s.cashier_id)) ?? "Unknown" },
      }),
    )

    const mappedOrders = (orderRefunds ?? []).map((row: Record<string, unknown>) =>
      mapRefund({ ...row, source: "order" }),
    )

    return NextResponse.json([...mappedPos, ...mappedOrders])
  } catch (error) {
    console.error("Get refunds error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

async function refundPosSale(params: {
  tenantId: string
  userId: string
  saleId: string
  reason: string
  restoreAs?: "active" | "quarantined"
}) {
  const { data, error } = await reversePharmacySale(db(), {
    tenantId: params.tenantId,
    saleId: params.saleId,
    actorId: params.userId,
    reason: params.reason,
    restoreAs: params.restoreAs ?? "quarantined",
  })

  if (error) {
    if (error.code === "ALREADY_REFUNDED") return { already: true as const, error }
    // Only a sale that does not exist may be looked up in the older transaction
    // table. A missing product line is a POS sale this route cannot refund.
    if (error.code === "SALE_NOT_FOUND") return { notFound: true as const, error }
    if (error.code === "PRODUCT_NOT_FOUND") return { lineMissing: true as const, error }
    if (error.code === "SALE_NOT_REFUNDABLE") {
      return { badStatus: true as const, error }
    }
    return { rpcFailed: true as const, error }
  }

  const result = (data ?? {}) as Record<string, unknown>
  return {
    ok: true as const,
    refundAmount: Number(result.refund_amount ?? 0),
    receivableReversal: Number(result.receivable_reversal ?? 0),
    creditBalanceAfter:
      result.credit_balance_after == null ? null : Number(result.credit_balance_after),
    receivableUnreversed: Number(result.receivable_unreversed ?? 0),
    receivableUnposted: result.receivable_unposted === true,
    sale: data,
  }
}

// POST - Process a refund (POS void preferred; order tx fallback)
export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("pos.refund")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    if (!tenantId) {
      return NextResponse.json({ error: "No tenant" }, { status: 403 })
    }

    const body = await request.json()
    const { transactionId, saleId, reason, restoreAs, items } = body as {
      transactionId?: string
      saleId?: string
      reason?: string
      restoreAs?: "active" | "quarantined"
      items?: Array<{ id: string; quantity: number }>
    }

    const id = transactionId ?? saleId
    if (!id) {
      return NextResponse.json({ error: "Transaction ID is required" }, { status: 400 })
    }

    const refundReason = typeof reason === "string" && reason.trim() ? reason.trim() : ""
    if (!refundReason) {
      return NextResponse.json({ error: "Refund reason is required" }, { status: 400 })
    }

    const posResult = await refundPosSale({
      tenantId,
      userId: session.user.id,
      saleId: id,
      reason: refundReason,
      restoreAs: restoreAs === "active" ? "active" : "quarantined",
    })

    if ("already" in posResult && posResult.already) {
      return NextResponse.json(
        {
          error: posResult.error?.humanMessage ?? "Transaction already refunded",
          code: "ALREADY_REFUNDED",
        },
        { status: 409 },
      )
    }
    if ("badStatus" in posResult && posResult.badStatus) {
      return NextResponse.json(
        {
          error: posResult.error?.humanMessage ?? "Sale is not refundable",
          code: "SALE_NOT_REFUNDABLE",
        },
        { status: 400 },
      )
    }
    if ("lineMissing" in posResult && posResult.lineMissing) {
      return NextResponse.json(
        {
          error:
            "A product on this sale no longer exists in the catalogue, so its stock cannot be restored. Recreate the product before refunding.",
          code: "PRODUCT_NOT_FOUND",
        },
        { status: 409 },
      )
    }
    if ("rpcFailed" in posResult && posResult.rpcFailed) {
      return NextResponse.json(
        {
          error: posResult.error?.humanMessage ?? "Failed to void POS sale",
          code: posResult.error?.code,
        },
        { status: 400 },
      )
    }
    if ("ok" in posResult && posResult.ok) {
      const { data: saleRow } = await db()
        .from("pharmacy_pos_sales")
        .select("payment_method, cashier_id")
        .eq("id", id)
        .eq("tenant_id", tenantId)
        .maybeSingle()
      await attachSaleToTill({
        tenantId,
        cashierId: String(saleRow?.cashier_id ?? session.user.id),
        paymentMethod: String(saleRow?.payment_method ?? "cash"),
        amount: posResult.refundAmount,
        kind: "refund",
        required: false,
        sourceId: `refund:${id}`,
      })
      return NextResponse.json({
        success: true,
        refundAmount: posResult.refundAmount,
        receivableReversal: posResult.receivableReversal,
        creditBalanceAfter: posResult.creditBalanceAfter,
        receivableUnreversed: posResult.receivableUnreversed,
        receivableUnposted: posResult.receivableUnposted,
        transaction: posResult.sale,
        source: "pos",
      })
    }
    // notFound → try legacy pharmacy_transactions path below

    // Legacy / order path — restore product qty only; never invent batches
    const { data: transaction, error: fetchError } = await db()
      .from("pharmacy_transactions")
      .select(
        `
        *,
        items:pharmacy_transaction_items (
          *,
          product:pharmacy_products ( id, name, quantity )
        )
      `,
      )
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .single()

    if (fetchError || !transaction) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    }

    if (transaction.status === "REFUNDED") {
      return NextResponse.json(
        { error: "Transaction already refunded", code: "ALREADY_REFUNDED" },
        { status: 409 },
      )
    }

    // The Tally mirror reports a sale whose ledger entry came from the Tally
    // voucher. Marking it refunded here would move the portal's copy and post
    // nothing, so refuse before any stock or balance changes.
    if (isTallyMirrorNote((transaction as { notes?: string | null }).notes)) {
      return NextResponse.json(
        {
          error: "This sale was imported from Tally and is read-only in the portal.",
          code: "TALLY_MIRROR_READ_ONLY",
        },
        { status: 409 },
      )
    }

    interface RefundItemInput {
      id: string
      quantity: number
    }

    interface TransactionItemRow {
      id: string
      product_id: string
      unit_price: number
      quantity: number
      product: { id: string; name: string; quantity: number } | null
    }

    const itemsToRefund: RefundItemInput[] =
      items && items.length > 0
        ? (items as RefundItemInput[])
        : (transaction.items as TransactionItemRow[]).map((i) => ({
            id: i.id,
            quantity: i.quantity,
          }))

    // What the customer actually paid is the header figure, not the sum of
    // line prices: lines exclude the tax added on top and the discount taken
    // off. Legacy order txs are not POS sales, so no stock is moved here —
    // returned units stay non-sellable until a pharmacist receives or
    // quarantines them through the inventory RPCs.
    const transactionHeader = transaction as { discount?: number | null; tax?: number | null }
    const refundAmount = allocateRefundAmount({
      lines: (transaction.items as TransactionItemRow[]).map((item) => ({
        id: item.id,
        quantity: Number(item.quantity ?? 0),
        unit_price: Number(item.unit_price ?? 0),
      })),
      refunded: itemsToRefund,
      discount: transactionHeader.discount,
      tax: transactionHeader.tax,
    })

    const existingNotes = (transaction as { notes: string | null }).notes ?? ""
    const { data: updatedTransaction, error: updateError } = await supabaseAdmin
      .from("pharmacy_transactions")
      .update({
        status: "REFUNDED",
        notes: `${existingNotes}\n[REFUNDED] ${new Date().toISOString()}: ${refundReason} - Amount: ${refundAmount}`.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .select(
        `
        *,
        cashier:profiles!pharmacy_transactions_cashier_id_fkey ( full_name ),
        items:pharmacy_transaction_items (*)
      `,
      )
      .single()

    if (updateError || !updatedTransaction) {
      console.error("Update transaction status error:", updateError)
      return NextResponse.json({ error: "Failed to update transaction status" }, { status: 500 })
    }

    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "REFUND_TRANSACTION",
      entity: "TRANSACTION",
      entity_id: id,
      details: `Refunded transaction ${transaction.transaction_no}. Amount: ${refundAmount}. Reason: ${refundReason}`,
    })

    return NextResponse.json({
      success: true,
      refundAmount,
      transaction: updatedTransaction,
      source: "order",
      warning:
        "Legacy order refund restored product quantity only. Units are not sellable until received onto a genuine batch.",
    })
  } catch (error) {
    console.error("Process refund error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
