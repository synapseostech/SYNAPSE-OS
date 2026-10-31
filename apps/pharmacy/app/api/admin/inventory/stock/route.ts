import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  adjustPharmacyBatchStock,
  receivePharmacyStock,
  type PharmacyRpcError,
} from "@synapse/db/inventory-rpc"

const db = () => supabaseAdmin as any

function rpcFail(err: PharmacyRpcError, status = 400) {
  return NextResponse.json(
    { error: err.humanMessage, code: err.code, detail: err.message },
    { status },
  )
}

/**
 * Authoritative stock adjustment.
 * INCREASE requires genuine batchNumber + expiryDate (receive_pharmacy_stock).
 * DECREASE removes from a batch (or FEFO across sellable batches).
 * CORRECTION requires batchId and sets that batch's absolute quantity.
 * DAMAGE / QUARANTINE / RECALL require batchId and update batch status only.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("inventory.adjust")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const body = (await request.json()) as {
      productId: string
      quantity: number
      type: string
      reason?: string
      batchId?: string
      batchNumber?: string
      expiryDate?: string
      costPrice?: number
      sellingPrice?: number
    }

    const {
      productId,
      quantity,
      type,
      reason,
      batchId,
      batchNumber,
      expiryDate,
      costPrice,
      sellingPrice,
    } = body

    if (!productId || quantity == null || !type) {
      return NextResponse.json(
        { error: "Product ID, quantity, and type are required" },
        { status: 400 },
      )
    }

    const { data: product } = await db()
      .from("pharmacy_products")
      .select("id, name, quantity, reorder_level")
      .eq("tenant_id", tenantId)
      .eq("id", productId)
      .maybeSingle()

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 })
    }

    const previousQty: number = product.quantity ?? 0
    const reorderLevel = Number(product.reorder_level ?? 0)
    const adjType = String(type).toUpperCase()
    const adjReason = reason?.trim() || `Stock ${adjType.toLowerCase()}`

    if (adjType === "INCREASE") {
      if (!batchNumber?.trim() || !expiryDate) {
        return NextResponse.json(
          {
            error:
              "Stock increases require a genuine batch number and future expiry date. This prevents phantom sellable stock.",
            code: "REQUIRES_BATCH",
          },
          { status: 400 },
        )
      }
      const { data, error } = await receivePharmacyStock(db(), {
        tenantId,
        productId,
        batchNumber,
        quantity: Number(quantity),
        expiryDate,
        costPrice: costPrice ?? null,
        sellingPrice: sellingPrice ?? null,
        receivedBy: session.user.id,
        reason: adjReason,
      })
      if (error) return rpcFail(error)

      const newQty = previousQty + Number(quantity)
      if (reorderLevel > 0 && previousQty > reorderLevel && newQty <= reorderLevel) {
        const { notifyPharmacyStock } = await import("@synapse/auth/mobile-push")
        notifyPharmacyStock({
          tenantId,
          productName: product.name,
          reason: "reorder",
          detail: `${product.name} is at ${newQty} (reorder ${reorderLevel}).`,
        })
      }

      return NextResponse.json({
        product: { id: productId, quantity: newQty },
        adjustment: {
          previousQty,
          quantity: Number(quantity),
          newQty,
          type: adjType,
          batchId: data?.batchId,
        },
      })
    }

    const { data, error } = await adjustPharmacyBatchStock(db(), {
      tenantId,
      productId,
      quantity: Number(quantity),
      type: adjType as "DECREASE" | "CORRECTION" | "DAMAGE" | "QUARANTINE" | "RECALL",
      reason: adjReason,
      actorId: session.user.id,
      batchId: batchId ?? null,
      batchNumber: batchNumber ?? null,
      expiryDate: expiryDate ?? null,
      costPrice: costPrice ?? null,
    })

    if (error) {
      const status = error.code === "INSUFFICIENT_STOCK" || error.code === "INSUFFICIENT_BATCH" ? 409 : 400
      return rpcFail(error, status)
    }

    const newQty = Number((data as any)?.new_qty ?? previousQty)
    if (reorderLevel > 0 && previousQty > reorderLevel && newQty <= reorderLevel) {
      const { notifyPharmacyStock } = await import("@synapse/auth/mobile-push")
      notifyPharmacyStock({
        tenantId,
        productName: product.name,
        reason: "reorder",
        detail: `${product.name} is at ${newQty} (reorder ${reorderLevel}).`,
      })
    }

    return NextResponse.json({
      product: { id: productId, quantity: newQty },
      adjustment: {
        previousQty,
        quantity: Number(quantity),
        newQty,
        type: adjType,
        result: data,
      },
    })
  } catch (error) {
    console.error("Stock update error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
