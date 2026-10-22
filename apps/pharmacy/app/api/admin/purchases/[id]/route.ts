import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { mapPurchase } from "@/lib/api-serialize"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { derivePaymentStatus, roundMoney } from "@synapse/db/pharmacy-purchases"

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

async function loadNames(createdBy?: string | null, receivedBy?: string | null) {
  const ids = [createdBy, receivedBy].filter(Boolean) as string[]
  if (ids.length === 0) return { createdByName: "Unknown", receivedByName: null as string | null }
  const { data: profiles } = await db()
    .from("profiles")
    .select("id, full_name, first_name, last_name")
    .in("id", ids)
  const nameOf = (id: string | null | undefined) => {
    if (!id) return null
    const p = (profiles ?? []).find((row: { id: string }) => row.id === id)
    return p ? p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "Unknown"
  }
  return {
    createdByName: nameOf(createdBy) ?? "Unknown",
    receivedByName: nameOf(receivedBy),
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePharmacyPermission(["purchasing.manage", "inventory.read"])
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data, error } = await db()
    .from("pharmacy_purchases")
    .select(PURCHASE_SELECT)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Purchase not found" }, { status: 404 })

  const names = await loadNames(data.created_by, data.received_by)
  const { data: audits } = await db()
    .from("pharmacy_audit_logs")
    .select("id, action, entity, details, created_at, profile_id")
    .eq("tenant_id", tenantId)
    .eq("entity_id", id)
    .order("created_at", { ascending: false })
    .limit(50)

  return NextResponse.json({
    purchase: mapPurchase(data as Record<string, unknown>, names),
    audit: audits ?? [],
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePharmacyPermission("purchasing.manage")
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const { data: purchase, error } = await db()
    .from("pharmacy_purchases")
    .select("id, status, total, amount_paid, payment_status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!purchase) return NextResponse.json({ error: "Purchase not found" }, { status: 404 })

  if (body.status === "CANCELLED") {
    if (purchase.status === "RECEIVED" || purchase.status === "PARTIALLY_RECEIVED") {
      return NextResponse.json(
        { error: "Received purchases cannot be cancelled. Use a supplier return to reverse stock." },
        { status: 400 },
      )
    }
    await db()
      .from("pharmacy_purchases")
      .update({ status: "CANCELLED", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenantId)
    await db().from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "purchase.cancelled",
      entity: "PURCHASE",
      entity_id: id,
      details: "Purchase cancelled before receipt",
    })
    return NextResponse.json({ ok: true, status: "CANCELLED" })
  }

  const amountPaid =
    body.amountPaid != null ? Number(body.amountPaid) : Number(purchase.amount_paid ?? 0)
  const total = Number(purchase.total ?? 0)
  const currentAmountPaid = Number(purchase.amount_paid ?? 0)
  if (!Number.isFinite(amountPaid) || amountPaid < currentAmountPaid || amountPaid > total ||
    Math.abs(amountPaid * 100 - Math.round(amountPaid * 100)) > 0.000001) {
    return NextResponse.json(
      { error: `Amount paid must be between ${currentAmountPaid} and ${total}.` },
      { status: 400 },
    )
  }
  const paymentStatus = derivePaymentStatus({
    total,
    amountPaid,
    explicit: typeof body.paymentStatus === "string" ? body.paymentStatus : null,
  })
  const update: Record<string, unknown> = {
    amount_paid: amountPaid,
    balance: roundMoney(Math.max(0, total - amountPaid)),
    payment_status: paymentStatus,
    updated_at: new Date().toISOString(),
  }
  if (typeof body.paymentMethod === "string") {
    const paymentMethod = body.paymentMethod.trim().toLowerCase()
    if (paymentMethod && !["cash", "mobile_money", "mobile money", "card", "bank_transfer", "bank transfer"].includes(paymentMethod)) {
      return NextResponse.json({ error: "Choose a supported payment method." }, { status: 400 })
    }
    if (paymentMethod) update.payment_method = paymentMethod
  }
  if (typeof body.notes === "string") update.notes = body.notes

  const { error: updateError } = await db()
    .from("pharmacy_purchases")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (updateError) {
    const message = String(updateError.message ?? "")
    if (message.includes("ACCOUNTING_PERIOD_CLOSED")) {
      return NextResponse.json({ error: "The payment could not be posted because its accounting period is closed." }, { status: 409 })
    }
    if (message.includes("ACCOUNTING_SUPPLIER_PAYMENT_AMOUNT_INVALID")) {
      return NextResponse.json({ error: "The supplier payment amount is invalid." }, { status: 400 })
    }
    console.error("Update purchase payment error:", updateError)
    return NextResponse.json({ error: "Failed to record supplier payment." }, { status: 500 })
  }

  await db().from("pharmacy_audit_logs").insert({
    tenant_id: tenantId,
    profile_id: session.user.id,
    action: "purchase.payment_status_changed",
    entity: "PURCHASE",
    entity_id: id,
    details: JSON.stringify({ payment_status: paymentStatus, amount_paid: amountPaid }),
  })

  return NextResponse.json({ ok: true, paymentStatus, amountPaid, balance: update.balance })
}
