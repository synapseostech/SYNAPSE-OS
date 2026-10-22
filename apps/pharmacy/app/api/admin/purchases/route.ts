import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { requireStoreScope } from "@/lib/pharmacy-context"
import { mapPurchase } from "@/lib/api-serialize"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { readIdempotencyKey } from "@/lib/pos/idempotency"
import { receivePharmacyPurchase, type ReceivePurchaseLine } from "@synapse/db/pharmacy-purchases"

const db = () => supabaseAdmin as any

const PURCHASE_SELECT = `
  *,
  supplier:pharmacy_suppliers(id, name, email, phone),
  items:pharmacy_purchase_items(
    id, product_id, product_name, quantity, received_quantity, purchase_unit,
    unit_cost, line_total, batch_number, expiry_date, manufacture_date, batch_id,
    selling_price, supplier_product_ref
  )
`

async function namesFor(rows: Array<{ created_by?: string | null; received_by?: string | null }>) {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.created_by) ids.add(row.created_by)
    if (row.received_by) ids.add(row.received_by)
  }
  const nameMap = new Map<string, string>()
  if (ids.size === 0) return nameMap
  const { data: profiles } = await db()
    .from("profiles")
    .select("id, full_name, first_name, last_name")
    .in("id", Array.from(ids))
  for (const p of profiles ?? []) {
    nameMap.set(
      p.id,
      p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() ?? p.id,
    )
  }
  return nameMap
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission(["purchasing.manage", "inventory.read"])
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const { searchParams } = new URL(request.url)
    const supplierId = searchParams.get("supplierId")
    const status = searchParams.get("status")
    const paymentStatus = searchParams.get("paymentStatus")
    const productId = searchParams.get("productId")
    const storeId = searchParams.get("storeId")
    const from = searchParams.get("from")
    const to = searchParams.get("to")

    let query = db()
      .from("pharmacy_purchases")
      .select(PURCHASE_SELECT)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })

    if (supplierId) query = query.eq("supplier_id", supplierId)
    if (status) query = query.eq("status", status)
    if (paymentStatus) query = query.eq("payment_status", paymentStatus)
    if (storeId) query = query.eq("store_id", storeId)
    if (from) query = query.gte("purchase_date", from)
    if (to) query = query.lte("purchase_date", to)

    const { data, error } = await query
    if (error) {
      console.error("Get purchases error:", error)
      return NextResponse.json({ error: "Failed to load purchases" }, { status: 500 })
    }

    let rows = (data ?? []) as Array<Record<string, unknown>>
    if (productId) {
      rows = rows.filter((row) =>
        ((row.items as Array<{ product_id?: string }> | null) ?? []).some((item) => item.product_id === productId),
      )
    }

    const nameMap = await namesFor(
      rows as Array<{ created_by?: string | null; received_by?: string | null }>,
    )

    return NextResponse.json({
      purchases: rows.map((row) =>
        mapPurchase(row, {
          createdByName: row.created_by ? nameMap.get(String(row.created_by)) : "Unknown",
          receivedByName: row.received_by ? nameMap.get(String(row.received_by)) ?? null : null,
        }),
      ),
    })
  } catch (error) {
    console.error("Get purchases error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission(["purchasing.manage", "inventory.adjust"])
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim().toLowerCase() : ""
    const amountPaid = Number(body.amountPaid ?? 0)
    if (!Number.isFinite(amountPaid) || amountPaid < 0 ||
      Math.abs(amountPaid * 100 - Math.round(amountPaid * 100)) > 0.000001) {
      return NextResponse.json({ error: "Amount paid must be a non-negative amount with at most two decimal places." }, { status: 400 })
    }
    if (paymentMethod && !["cash", "mobile_money", "mobile money", "card", "bank_transfer", "bank transfer"].includes(paymentMethod)) {
      return NextResponse.json({ error: "Choose a supported payment method." }, { status: 400 })
    }
    if (amountPaid > 0 && !paymentMethod) {
      return NextResponse.json({ error: "Select a payment method when recording an amount paid." }, { status: 400 })
    }
    const scoped = requireStoreScope(
      { ...auth, storeId: session.storeId ?? null },
      (body.storeId as string | null) ?? session.storeId ?? null,
    )
    if (!scoped.ok) return scoped.response

    const linesRaw = Array.isArray(body.lines) ? body.lines : Array.isArray(body.items) ? body.items : []
    const lines: ReceivePurchaseLine[] = linesRaw.map((line: Record<string, unknown>, index: number) => ({
      clientItemId: typeof line.clientItemId === "string" ? line.clientItemId : `line-${index}`,
      productId: String(line.productId ?? ""),
      productName: String(line.productName ?? ""),
      quantity: Number(line.quantity ?? 0),
      unitCost: Number(line.unitCost ?? line.costPrice ?? 0),
      purchaseUnit: (line.purchaseUnit as string | null) ?? null,
      batchNumber: String(line.batchNumber ?? ""),
      expiryDate: String(line.expiryDate ?? ""),
      manufactureDate: (line.manufactureDate as string | null) ?? null,
      sellingPrice: line.sellingPrice != null ? Number(line.sellingPrice) : null,
      updateSellingPrice: Boolean(line.updateSellingPrice),
      supplierProductRef: (line.supplierProductRef as string | null) ?? null,
      purchaseOrderItemId: (line.purchaseOrderItemId as string | null) ?? null,
    }))

    const idempotencyKey =
      readIdempotencyKey(request, body) ??
      (typeof body.purchaseId === "string" ? body.purchaseId : crypto.randomUUID())

    const result = await receivePharmacyPurchase(db(), {
      tenantId,
      actorId: session.user.id,
      storeId: scoped.storeId,
      supplierId: String(body.supplierId ?? ""),
      supplierInvoiceNo: (body.supplierInvoiceNo as string | null) ?? null,
      supplierReceiptRef: (body.supplierReceiptRef as string | null) ?? null,
      purchaseDate: (body.purchaseDate as string | null) ?? null,
      receivedDate: (body.receivedDate as string | null) ?? null,
      paymentStatus: (body.paymentStatus as string | null) ?? null,
      paymentMethod: paymentMethod || null,
      currency: (body.currency as string | null) ?? null,
      amountPaid,
      tax: body.tax != null ? Number(body.tax) : 0,
      discount: body.discount != null ? Number(body.discount) : 0,
      otherCost: body.otherCost != null ? Number(body.otherCost) : 0,
      notes: (body.notes as string | null) ?? null,
      purchaseOrderId: (body.purchaseOrderId as string | null) ?? null,
      idempotencyKey,
      receiveNow: body.receiveNow !== false,
      lines,
    })

    if (!result.ok) {
      const status =
        result.code === "SUPPLIER_NOT_FOUND" || result.code === "PO_NOT_FOUND"
          ? 404
          : result.code === "IDEMPOTENCY_KEY_REQUIRED"
            ? 400
            : 400
      return NextResponse.json(
        { error: result.error, code: result.code, detail: "detail" in result ? result.detail : undefined },
        { status },
      )
    }

    const { data: row } = await db()
      .from("pharmacy_purchases")
      .select(PURCHASE_SELECT)
      .eq("id", result.purchaseId)
      .eq("tenant_id", tenantId)
      .maybeSingle()

    return NextResponse.json({
      ok: true,
      replay: Boolean(result.replay),
      purchase: row
        ? mapPurchase(row as Record<string, unknown>, {
            createdByName: session.fullName || session.email || "Unknown",
            receivedByName: result.status === "RECEIVED" ? session.fullName || session.email : null,
          })
        : null,
      received: result.received,
    })
  } catch (error) {
    console.error("Create purchase error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
