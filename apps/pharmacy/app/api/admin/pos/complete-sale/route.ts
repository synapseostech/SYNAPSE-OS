import { NextRequest, NextResponse } from "next/server"
import { isPharmacyAdmin } from "@/lib/auth"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { gateFeature } from "@synapse/auth/features"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  findSaleIdempotency,
  readIdempotencyKey,
  storeSaleIdempotency,
} from "@/lib/pos/idempotency"
import {
  extractSaleErrorCode,
  friendlySaleError,
  isValidSaleQuantity,
  saleErrorHttpStatus,
  splitBatchSaleLine,
  validateSaleLine,
  type SaleLineInput,
} from "@/lib/pos/sale-validation"
import { buildStockError, type StructuredStockError } from "@synapse/db/inventory"
import { pharmacyDispenseTimelineEvent } from "@synapse/db/timeline"
import { publishTimelineEvent } from "@synapse/db/identity-persist"
import { attachSaleToTill, recordTillSale } from "@/lib/pos/till-service"
import { httpStatusForPharmacyError } from "@synapse/db/errors"
import { paymentStateForMethod } from "@synapse/db/cashier-session"
import { findOrCreateCreditCustomer, postCreditLedgerEntry } from "@/lib/credit-ledger"
import { encodePaymentRef, settlePayment } from "@/lib/pos/partial-payment"
import { verifyDiscountApproval } from "@/lib/pos/discount-approval"
import { tenantOwnsRecord } from "@/lib/tenant-ownership"
import { allocateFefoBatches, kampalaToday } from "@/lib/pos/fefo"

/**
 * Complete a POS sale via live `complete_pharmacy_sale` RPC.
 * Server recomputes list prices from catalog; cashiers cannot invent prices.
 * Cashier identity is always the authenticated session user.
 * Nonzero discount_amount requires discount_reason (DB constraint).
 * Optional Idempotency-Key prevents duplicate sales on retry.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePharmacyPermission("pos.sell")
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

  const gate = await gateFeature(tenantId, "pos.sell")
  if (gate) return gate

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const idempotencyKey = readIdempotencyKey(request, body as Record<string, unknown>)
  if (idempotencyKey) {
    const prior = await findSaleIdempotency(tenantId, idempotencyKey)
    if (prior) {
      return NextResponse.json(
        { ok: true, sale: prior.response, idempotentReplay: true },
        { status: 200, headers: { "X-Idempotent-Replay": "true" } },
      )
    }
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for (const [field, code] of [["cartId", "INVALID_CART_ID"], ["patientId", "INVALID_PATIENT_ID"]] as const) {
    const v = (body as Record<string, unknown>)[field]
    if (v != null && v !== "" && (typeof v !== "string" || !UUID_RE.test(v))) {
      return NextResponse.json({ error: `${field} must be a UUID`, code }, { status: 400 })
    }
  }

  // A client-supplied patient id is a foreign key written under the service
  // role, so it must be proven to belong to this tenant before the sale
  // references it. Reported as not-found so other tenants' ids cannot be probed.
  const patientId =
    typeof body.patientId === "string" && body.patientId.length > 0 ? body.patientId : null
  if (patientId && !(await tenantOwnsRecord("patients", tenantId, patientId))) {
    return NextResponse.json(
      { error: "Patient not found", code: "PATIENT_NOT_FOUND" },
      { status: 404 },
    )
  }

  const itemsIn = Array.isArray(body.items) ? (body.items as SaleLineInput[]) : []
  if (itemsIn.length === 0) {
    return NextResponse.json({ error: "Cart is empty" }, { status: 400 })
  }

  const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : ""
  if (!paymentMethod) {
    return NextResponse.json({ error: "paymentMethod is required" }, { status: 400 })
  }

  const amountPaidRaw = body.amountPaid
  const amountPaid =
    amountPaidRaw === undefined || amountPaidRaw === null || amountPaidRaw === ""
      ? null
      : Number(amountPaidRaw)
  if (amountPaid != null && (!Number.isFinite(amountPaid) || amountPaid < 0)) {
    return NextResponse.json({ error: "amountPaid must be a non-negative number" }, { status: 400 })
  }

  const clientName = typeof body.clientName === "string" ? body.clientName.trim() : ""
  const clientPhone = typeof body.clientPhone === "string" ? body.clientPhone.trim() : ""
  const clientAddress = typeof body.clientAddress === "string" ? body.clientAddress.trim() : ""
  const creditDueDate = typeof body.creditDueDate === "string" ? body.creditDueDate.trim() : ""
  const customerIdBody = typeof body.customerId === "string" ? body.customerId.trim() : ""

  // Authenticated user is always the cashier. Client-supplied staffId is ignored.
  const cashierId = session.userId

  const db = supabaseAdmin as any

  const { data: settings } = await db
    .from("pharmacy_settings")
    .select("discount_approval_threshold_pct, vat_enabled, vat_rate, tax_rate")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  const threshold = Number(settings?.discount_approval_threshold_pct ?? 5)
  // Approval must be a server-issued token from supervisor-approve, bound to this
  // tenant and cashier. A raw supervisor id supplied by the client is not proof.
  const approvedBy = verifyDiscountApproval(body.discountApprovalToken ?? body.discountApprovedBy, {
    tenantId,
    cashierId: session.userId,
  })

  if (customerIdBody && !(await tenantOwnsRecord("pharmacy_customers", tenantId, customerIdBody))) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 })
  }

  const rpcItems: Record<string, unknown>[] = []

  for (const raw of itemsIn) {
    const productId = String(raw.productId ?? "")
    const { data: product } = await db
      .from("pharmacy_products")
      .select("id, price, name, is_active")
      .eq("id", productId)
      .eq("tenant_id", tenantId)
      .maybeSingle()

    if (!product || product.is_active === false) {
      const missing = validateSaleLine({
        raw,
        product: null,
        thresholdPct: threshold,
        isAdmin: isPharmacyAdmin(session),
        actorUserId: session.userId,
        approvedBy,
      })
      if (!missing.ok) {
        return NextResponse.json({ error: missing.error }, { status: missing.status })
      }
      return NextResponse.json({ error: `Product not found: ${productId}` }, { status: 404 })
    }

    const quantity = Number(raw.quantity)
    if (!isValidSaleQuantity(quantity)) {
      const invalid = validateSaleLine({
        raw,
        product: { id: product.id, price: Number(product.price ?? 0), is_active: product.is_active },
        thresholdPct: threshold,
        isAdmin: isPharmacyAdmin(session),
        actorUserId: session.userId,
        approvedBy,
      })
      if (!invalid.ok) return NextResponse.json({ error: invalid.error }, { status: invalid.status })
      return NextResponse.json({ error: "Invalid cart item quantity" }, { status: 400 })
    }

    const { data: batchRows, error: batchError } = await db
      .from("pharmacy_product_batches")
      .select("id, batch_number, quantity, expiry_date, cost_price, selling_price, manufacturer, is_active, status")
      .eq("tenant_id", tenantId)
      .eq("product_id", product.id)
      .eq("is_active", true)
      .gt("quantity", 0)

    if (batchError) {
      console.error("[pos] batch price lookup failed:", batchError)
      return NextResponse.json({ error: "Could not verify batch prices" }, { status: 500 })
    }

    const basePrice = Number(product.price ?? 0)
    const sellableRows = (batchRows ?? []).filter(
      (batch: { status?: string | null }) => (batch.status ?? "active") === "active",
    )
    const allocations = allocateFefoBatches(
      sellableRows.map((batch: Record<string, unknown>) => ({
        id: String(batch.id),
        batchNumber: String(batch.batch_number ?? ""),
        quantity: Number(batch.quantity ?? 0),
        expiryDate: batch.expiry_date ? String(batch.expiry_date).slice(0, 10) : null,
        manufacturer: typeof batch.manufacturer === "string" ? batch.manufacturer : null,
        costPrice: batch.cost_price == null ? null : Number(batch.cost_price),
        sellingPrice:
          batch.selling_price == null ? basePrice : Number(batch.selling_price),
      })),
      quantity,
      kampalaToday(),
    )
    const allocatedQuantity = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0)
    if (allocatedQuantity !== quantity) {
      return NextResponse.json(
        { error: "Batch stock changed. Refresh the cart and retry.", code: "INSUFFICIENT_STOCK" },
        { status: 409 },
      )
    }

    const listTotal = allocations.reduce(
      (sum, allocation) => sum + allocation.quantity * Number(allocation.sellingPrice ?? basePrice),
      0,
    )
    const weightedUnitPrice = listTotal / quantity
    const snapshot = raw.batchAllocations
    if (snapshot !== undefined) {
      const incoming = Array.isArray(snapshot) ? snapshot : []
      if (incoming.some((allocation) => !allocation || typeof allocation !== "object")) {
        return NextResponse.json(
          { error: "Batch allocation changed. Refresh the cart and retry.", code: "BATCH_ALLOCATION_CHANGED" },
          { status: 409 },
        )
      }
      const currentById = new Map(allocations.map((allocation) => [allocation.batchId, allocation]))
      const allocationMatches =
        incoming.length === allocations.length &&
        incoming.every((allocation) => {
          const current = currentById.get(String(allocation.batchId))
          return current?.quantity === Number(allocation.quantity)
        })
      if (!allocationMatches) {
        return NextResponse.json(
          { error: "Batch allocation changed. Refresh the cart and retry.", code: "BATCH_ALLOCATION_CHANGED" },
          { status: 409 },
        )
      }
      const priceMatches = incoming.every((allocation) => {
        const current = currentById.get(String(allocation.batchId))
        return (
          current != null &&
          Number.isFinite(Number(allocation.sellingPrice)) &&
          Math.abs(Number(allocation.sellingPrice) - Number(current.sellingPrice ?? basePrice)) < 0.005
        )
      })
      if (!priceMatches || !Number.isFinite(Number(raw.listPrice)) ||
        Math.abs(Number(raw.listPrice) - weightedUnitPrice) >= 0.005) {
        return NextResponse.json(
          { error: "A batch selling price changed. Refresh the cart and retry.", code: "BATCH_PRICE_CHANGED" },
          { status: 409 },
        )
      }
    }

    const validated = validateSaleLine({
      raw: {
        ...raw,
        unitPrice: snapshot === undefined ? weightedUnitPrice : raw.unitPrice,
      },
      product: { id: product.id, price: weightedUnitPrice, is_active: product.is_active },
      thresholdPct: threshold,
      isAdmin: isPharmacyAdmin(session),
      actorUserId: session.userId,
      approvedBy,
    })

    if (!validated.ok) {
      return NextResponse.json(
        {
          error: validated.error,
          ...(validated.code ? { code: validated.code } : {}),
          ...(validated.threshold != null ? { threshold: validated.threshold } : {}),
        },
        { status: validated.status },
      )
    }

    const splitItems = splitBatchSaleLine(
      allocations.map((allocation) => ({
        batchId: allocation.batchId,
        quantity: allocation.quantity,
        listPrice: Number(allocation.sellingPrice ?? basePrice),
      })),
      validated.rpcItem.discount_amount,
    )
    if (splitItems.length !== allocations.length) {
      return NextResponse.json(
        { error: "Discount exceeds the batch-priced line total", code: "INVALID_DISCOUNT" },
        { status: 400 },
      )
    }
    for (const item of splitItems) {
      rpcItems.push({
        ...validated.rpcItem,
        batch_id: item.batch_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        list_price: item.unit_price,
        discount_amount: item.discount_amount,
      })
    }
  }

  const saleAmount = rpcItems.reduce(
    (sum, item) =>
      sum +
      Number(item.unit_price ?? 0) * Number(item.quantity ?? 0) -
      Number(item.discount_amount ?? 0),
    0,
  )
  const taxAmount = Number(body.taxAmount ?? 0)
  const grandTotal = saleAmount + (Number.isFinite(taxAmount) ? taxAmount : 0)

  const methodUpper = paymentMethod.toUpperCase()
  const isCreditSale = methodUpper === "CREDIT"
  // Cash/mobile/card underpayment → balance due on customer account.
  const tendered = amountPaid == null ? (isCreditSale ? 0 : grandTotal) : amountPaid
  const settlement = settlePayment(grandTotal, tendered)

  if (settlement.isPartial && !isCreditSale && !clientName && !customerIdBody) {
    return NextResponse.json(
      {
        error:
          "Partial payment requires a customer name (or selected credit customer) so the balance can be recorded.",
        code: "CUSTOMER_REQUIRED_FOR_BALANCE",
        balanceDue: settlement.balanceDue,
      },
      { status: 400 },
    )
  }

  // The till is optional: a sale completes without one and simply has no cash to
  // reconcile. When a till is open its session id is captured here, and cash is
  // credited only after the sale RPC commits (see recordTillSale below).
  const till = await attachSaleToTill({
    tenantId,
    cashierId,
    paymentMethod,
    amount: 0,
    kind: "sale",
    required: false,
  })
  if (!till.ok) {
    return NextResponse.json(till.error, { status: httpStatusForPharmacyError(till.error.code) })
  }
  const paymentState = paymentStateForMethod({
    method: paymentMethod,
    offline: false,
    providerConfirmed: paymentMethod.toLowerCase() === "cash",
  })
  void paymentState

  const paymentRef = encodePaymentRef({
    amountPaid: settlement.amountPaid,
    balanceDue: settlement.balanceDue,
    method: paymentMethod,
    existingRef: typeof body.paymentRef === "string" ? body.paymentRef : null,
  })

  // Line discounts live on rpc items; p_discount_total must stay 0 or RPC double-counts.
  const { data, error } = await db.rpc("complete_pharmacy_sale", {
    p_tenant_id: tenantId,
    p_cashier_id: cashierId,
    p_items: rpcItems,
    p_payment_method: paymentMethod,
    p_session_id: till.sessionId,
    p_cart_id: body.cartId || null,
    p_payment_ref: paymentRef,
    p_discount_total: 0,
    p_tax_amount: taxAmount,
    p_patient_id: patientId,
    p_confirmed_by: session.userId,
    // Always named: an older 11-argument overload still exists, so omitting it is ambiguous.
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    const msg = error.message ?? "Sale failed"
    const code = extractSaleErrorCode(msg)
    let stockError: StructuredStockError | null = null
    if (code === "INSUFFICIENT_STOCK" || code === "EXPIRED_BATCH_BLOCKED") {
      stockError = await buildPortalStockError(tenantId, rpcItems)
    }
    return NextResponse.json(
      {
        error: friendlySaleError(msg),
        code,
        ...(stockError ? { stockError } : {}),
      },
      { status: saleErrorHttpStatus(msg) },
    )
  }

  const sale = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const saleId = String(sale.sale_id ?? sale.id ?? "") || null
  const receiptNumber = String(sale.receipt_number ?? "")

  if (till.sessionId) {
    // Cash kept in the drawer: what was paid on a partial sale, otherwise the total (change goes back).
    const cashReceived = settlement.isPartial ? settlement.amountPaid : grandTotal
    try {
      await recordTillSale({ tenantId, sessionId: till.sessionId, paymentMethod, amount: cashReceived, saleId, actorId: session.userId })
    } catch (err) {
      console.error("[pos] till cash record failed:", err)
    }
  }


  // Persist balance due on credit ledger + audit for monitoring shortfalls.
  let creditCustomerId: string | null = customerIdBody || null
  let balanceAfter: number | null = null
  let creditWarning: string | null = null
  if (settlement.balanceDue > 0 || isCreditSale) {
    try {
      if (!creditCustomerId) {
        creditCustomerId = await findOrCreateCreditCustomer(tenantId, {
          name: clientName || "Walk-in (balance due)",
          phone: clientPhone || null,
          address: clientAddress || null,
        })
      }
      const creditAmount = isCreditSale && settlement.amountPaid <= 0
        ? settlement.total
        : settlement.balanceDue
      if (creditAmount > 0) {
        const entry = await postCreditLedgerEntry({
          tenantId,
          customerId: creditCustomerId,
          amount: creditAmount,
          type: "credit",
          transactionId: null, // POS sales use pharmacy_pos_sales; FK is pharmacy_transactions
          dueDate: creditDueDate || null,
          notes: `POS ${receiptNumber || saleId || "sale"} | paid ${settlement.amountPaid} | balance ${creditAmount}`,
          createdBy: session.userId,
          // One credit posting per sale, even if this request is retried.
          idempotencyKey: saleId ? `pos-sale:${saleId}` : null,
        })
        balanceAfter = Number(entry.balance_after ?? creditAmount)
      }

      // Explicit underpayment audit for monitoring (negative variance).
      if (settlement.isPartial) {
        await db.from("pharmacy_audit_logs").insert({
          tenant_id: tenantId,
          profile_id: session.userId,
          action: "POS_UNDERPAYMENT",
          entity: "PHARMACY_POS_SALE",
          entity_id: saleId,
          details: JSON.stringify({
            receiptNumber,
            total: settlement.total,
            amountPaid: settlement.amountPaid,
            balanceDue: settlement.balanceDue,
            variance: -settlement.balanceDue,
            paymentMethod,
            customerId: creditCustomerId,
          }),
        })
      }
    } catch (creditErr) {
      console.error("[pos] credit ledger / underpayment audit failed:", creditErr)
      // Sale already completed — do not roll back stock, but the receivable was
      // not recorded, so the cashier must be told instead of losing it silently.
      creditWarning =
        "Sale completed, but the credit balance could not be recorded. Post it from the credit ledger."
    }
  }

  const responseBody = {
    ok: true as const,
    sale: data,
    settlement: {
      amountPaid: settlement.amountPaid,
      change: settlement.change,
      balanceDue: settlement.balanceDue,
      isPartial: settlement.isPartial,
      customerId: creditCustomerId,
      balanceAfter,
    },
    ...(creditWarning ? { creditWarning } : {}),
  }
  if (idempotencyKey) {
    await storeSaleIdempotency({
      tenantId,
      key: idempotencyKey,
      userId: session.userId,
      saleId,
      response: { ...((data && typeof data === "object" ? data : {}) as object), settlement: responseBody.settlement },
    })
  }

  void (async () => {
    try {
      if (!saleId) return
      const personId = typeof body.personId === "string" ? body.personId : null
      const patientId = typeof body.patientId === "string" ? body.patientId : null
      if (!personId && !patientId) return
      const names = rpcItems.map((i) => String(i.product_name ?? i.product_id)).slice(0, 4)
      await publishTimelineEvent(
        pharmacyDispenseTimelineEvent({
          tenantId,
          personId,
          patientId,
          siteId: typeof body.storeId === "string" ? body.storeId : null,
          saleId,
          receiptNumber,
          facilityName: session.tenantName,
          itemSummary: names.join(", "),
          createdBy: session.userId,
        }),
      )
    } catch (err) {
      console.error("[pos] timeline publish failed:", err)
    }
  })()

  // After sale, push if any sold product crossed below reorder
  void (async () => {
    try {
      const productIds = [...new Set(rpcItems.map((i) => String(i.product_id)))]
      if (productIds.length === 0) return
      const { data: products } = await db
        .from("pharmacy_products")
        .select("id, name, quantity, reorder_level")
        .eq("tenant_id", tenantId)
        .in("id", productIds)
      const low = (products ?? []).filter(
        (p: { quantity?: number; reorder_level?: number }) =>
          Number(p.reorder_level ?? 0) > 0 &&
          Number(p.quantity ?? 0) <= Number(p.reorder_level ?? 0),
      )
      if (low.length === 0) return
      const { notifyPharmacyStock } = await import("@synapse/auth/mobile-push")
      for (const p of low.slice(0, 5)) {
        notifyPharmacyStock({
          tenantId,
          productName: p.name,
          reason: "reorder",
          detail: `${p.name} is at ${p.quantity} (reorder ${p.reorder_level}).`,
        })
      }
    } catch (err) {
      console.error("[pos] reorder push failed:", err)
    }
  })()

  return NextResponse.json(responseBody)
}

/**
 * Recompute batch-derived stock for the requested lines and return the first line that
 * cannot be fully satisfied as a structured POS error. Best-effort (returns null on read failure).
 */
async function buildPortalStockError(
  tenantId: string,
  rpcItems: Record<string, unknown>[],
): Promise<StructuredStockError | null> {
  try {
    const db = supabaseAdmin as any
    const productIds = [...new Set(rpcItems.map((i) => String(i.product_id)))]
    if (productIds.length === 0) return null
    const { data: products } = await db
      .from("pharmacy_products")
      .select(
        `id, name, quantity, is_active,
         pharmacy_product_batches(id, batch_number, quantity, expiry_date, is_active, manufacturer)`,
      )
      .eq("tenant_id", tenantId)
      .in("id", productIds)

    const byId = new Map<string, any>()
    for (const p of products ?? []) byId.set(String(p.id), p)

    for (const item of rpcItems) {
      const pid = String(item.product_id)
      const product = byId.get(pid)
      const err = buildStockError({
        product: product
          ? { id: pid, name: String(product.name ?? ""), quantity: product.quantity, is_active: product.is_active }
          : { id: pid, name: "Unknown product", quantity: 0 },
        batches: product?.pharmacy_product_batches ?? [],
        requestedQuantity: Number(item.quantity ?? 0),
      })
      if (err) return err
    }
    return null
  } catch {
    return null
  }
}
