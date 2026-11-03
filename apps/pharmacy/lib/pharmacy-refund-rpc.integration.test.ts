import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { supabaseAdmin } from "@synapse/db/admin"
import { adjustPharmacyBatchStock, reversePharmacySale } from "@synapse/db/inventory-rpc"
import { hasDb } from "./platform/test-db-guard"

/**
 * Behavioural proof for reverse_pharmacy_sale and adjust_pharmacy_batch_stock.
 *
 * These run only against a disposable database: CI's db-acceptance job exports
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY after replaying the canonical
 * snapshot and every migration past the snapshot cutoff, so the definitions
 * under test are the ones a real deployment gets. Skipped locally without
 * credentials — a skip is not evidence.
 *
 * The fixture sale is deliberately discounted and taxed (subtotal 2000,
 * discount 200, tax 100, total 1900). The old refund implementation summed
 * unit_price * quantity and would have reported 2000.
 */

if (!hasDb) {
  console.info(
    "[integration] pharmacy refund RPC tests skipped: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run them",
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

describe.skipIf(!hasDb)("pharmacy refund and stock-adjustment RPCs", () => {
  let tenantId: string
  let cashierId: string
  let foreignActorId: string
  let foreignTenantId: string

  beforeAll(async () => {
    tenantId = crypto.randomUUID()
    cashierId = crypto.randomUUID()
    foreignTenantId = crypto.randomUUID()
    foreignActorId = crypto.randomUUID()

    for (const [id, name, facility] of [
      [tenantId, "Refund RPC Pharmacy", "pharmacy"],
      [foreignTenantId, "Refund RPC Foreign Pharmacy", "pharmacy"],
    ] as const) {
      const { error } = await db.from("tenants").insert({
        id,
        slug: id,
        name,
        facility_type: facility,
        is_synthetic: true,
        environment: "demo",
        data_classification: "synthetic",
      })
      if (error) throw new Error(error.message)
    }

    // complete_pharmacy_sale now computes tax from pharmacy_settings and refuses
    // a caller figure that disagrees. 5% is what makes the fixture's 2000 line
    // carry the 100 tax asserted below.
    const { error: settingsError } = await db.from("pharmacy_settings").insert({
      tenant_id: tenantId,
      pharmacy_name: "Refund RPC Pharmacy",
      tax_rate: 5,
    })
    if (settingsError) throw new Error(settingsError.message)

    for (const [id, tenant, label] of [
      [cashierId, tenantId, "Synthetic Cashier"],
      [foreignActorId, foreignTenantId, "Foreign Cashier"],
    ] as const) {
      const { error } = await db.from("profiles").insert({
        id,
        email: `${id}@refund-rpc.invalid`,
        full_name: label,
        first_name: label.split(" ")[0],
        last_name: "Test",
        role: "pharmacist",
        tenant_id: tenant,
        verification_status: "verified",
      })
      if (error) throw new Error(error.message)
    }
  })

  afterAll(async () => {
    const { data: sales } = await db
      .from("pharmacy_pos_sales")
      .select("id")
      .in("tenant_id", [tenantId, foreignTenantId])
    const saleIds = (sales ?? []).map((row: { id: string }) => row.id)
    if (saleIds.length) {
      await db.from("pharmacy_pos_sale_items").delete().in("sale_id", saleIds)
    }
    for (const tenant of [tenantId, foreignTenantId]) {
      await db.from("pharmacy_audit_logs").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_stock_adjustments").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_sale_idempotency").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_credit_ledger").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_customers").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_pos_sales").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_product_batches").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_products").delete().eq("tenant_id", tenant)
    }
    await db.from("profiles").delete().in("id", [cashierId, foreignActorId])
    await db.from("tenants").delete().in("id", [tenantId, foreignTenantId])
  })

  interface Inventory {
    productId: string
    batchId: string
    price: number
    quantity: number
  }

  async function seedInventory(label: string): Promise<Inventory> {
    const price = 1000
    const quantity = 10
    const productId = crypto.randomUUID()
    const { error: productError } = await db.from("pharmacy_products").insert({
      id: productId,
      tenant_id: tenantId,
      name: `${label} ${productId.slice(0, 8)}`,
      sku: `RPC-${productId}`,
      price,
      cost_price: 500,
      quantity: 0,
      is_active: true,
    })
    if (productError) throw new Error(productError.message)

    const { data, error } = await db.rpc("receive_pharmacy_stock", {
      p_tenant_id: tenantId,
      p_product_id: productId,
      p_batch_number: `B-${productId}`,
      p_quantity: quantity,
      p_expiry_date: "2030-12-31",
      p_cost_price: 500,
      p_selling_price: price,
      p_received_by: cashierId,
      p_supplier_ref: "refund-rpc-test",
    })
    if (error) throw new Error(error.message)

    return { productId, batchId: String(data.batch_id), price, quantity }
  }

  interface Sale {
    saleId: string
    total: number
    quantity: number
    inventory: Inventory
  }

  interface Settlement {
    /** Tendered at the till. Omitted means the sale carries no payment tag. */
    paid?: number
    method?: string
  }

  async function completeDiscountedSale(inventory: Inventory, settlement?: Settlement): Promise<Sale> {
    const quantity = 2
    const subtotal = quantity * inventory.price
    const discount = 200
    const tax = 100
    const total = subtotal - discount + tax
    const method = settlement?.method ?? "cash"
    // The settlement tag must be written when the sale is created: the
    // append-only guard refuses a later update to a completed sale's financial
    // fields, and complete-sale writes the tag in this same shape.
    const paymentRef =
      settlement?.paid == null
        ? null
        : `PAID:${settlement.paid}|BAL:${total - settlement.paid}|M:${method.toUpperCase()}`

    const { data, error } = await db.rpc("complete_pharmacy_sale", {
      p_tenant_id: tenantId,
      p_cashier_id: cashierId,
      p_items: [
        {
          product_id: inventory.productId,
          batch_id: inventory.batchId,
          quantity,
          unit_price: inventory.price,
          discount_amount: 0,
        },
      ],
      p_payment_method: method,
      p_payment_ref: paymentRef,
      p_discount_total: discount,
      p_tax_amount: tax,
    })
    if (error) throw new Error(error.message)

    return {
      saleId: String(data.sale_id),
      total,
      quantity,
      inventory,
    }
  }

  async function quantities(inventory: Inventory) {
    const { data: product, error: productError } = await db
      .from("pharmacy_products")
      .select("quantity")
      .eq("id", inventory.productId)
      .eq("tenant_id", tenantId)
      .single()
    if (productError) throw new Error(productError.message)
    const { data: batch, error: batchError } = await db
      .from("pharmacy_product_batches")
      .select("quantity")
      .eq("id", inventory.batchId)
      .eq("tenant_id", tenantId)
      .single()
    if (batchError) throw new Error(batchError.message)
    return { product: Number(product.quantity), batch: Number(batch.quantity) }
  }

  async function saleStatus(saleId: string) {
    const { data, error } = await db
      .from("pharmacy_pos_sales")
      .select("status")
      .eq("id", saleId)
      .eq("tenant_id", tenantId)
      .single()
    if (error) throw new Error(error.message)
    return String(data.status)
  }

  // ---------------------------------------------------------------- credit ---

  async function seedCustomer(label: string): Promise<string> {
    const id = crypto.randomUUID()
    const { error } = await db.from("pharmacy_customers").insert({
      id,
      tenant_id: tenantId,
      name: label,
      email: `${id}@refund-rpc.invalid`,
      is_active: true,
    })
    if (error) throw new Error(error.message)
    return id
  }

  /** Exactly what complete-sale posts: the balance keyed to the sale id. */
  async function postSaleBalance(saleId: string, customerId: string, amount: number) {
    const { error } = await db.rpc("post_pharmacy_credit_entry", {
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_type: "credit",
      p_amount: amount,
      p_transaction_id: null,
      p_due_date: null,
      p_notes: `POS sale ${saleId}`,
      p_created_by: cashierId,
      p_idempotency_key: `pos-sale:${saleId}`,
      p_payment_method: "credit",
    })
    if (error) throw new Error(error.message)
  }

  async function ledger(customerId: string) {
    const { data, error } = await db
      .from("pharmacy_credit_ledger")
      .select("type, amount, balance_after, idempotency_key")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: true })
    if (error) throw new Error(error.message)
    return (data ?? []).map((row: Record<string, unknown>) => ({
      type: String(row.type),
      amount: Number(row.amount),
      balance: Number(row.balance_after),
      key: row.idempotency_key as string | null,
    }))
  }

  it("refunds only the cash on a part-paid sale and reverses the rest of the receivable", async () => {
    const inventory = await seedInventory("PartPaid")
    const sale = await completeDiscountedSale(inventory, { paid: 1000, method: "cash" })
    const customerId = await seedCustomer("Part-paid customer")
    await postSaleBalance(sale.saleId, customerId, 900)

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "customer returned the purchase",
      restoreAs: "active",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(1000)
    expect(Number(data?.receivable_reversal)).toBe(900)
    expect(Number(data?.receivable_outstanding)).toBe(900)
    expect(data?.receivable_unposted).toBe(false)
    expect(Number(data?.credit_balance_after)).toBe(0)
    expect(await ledger(customerId)).toEqual([
      { type: "credit", amount: 900, balance: 900, key: `pos-sale:${sale.saleId}` },
      { type: "refund", amount: 900, balance: 0, key: `pos-refund:${sale.saleId}` },
    ])
  })

  it("a fully-credit sale hands back no cash at all", async () => {
    const inventory = await seedInventory("FullCredit")
    const sale = await completeDiscountedSale(inventory, { paid: 0, method: "credit" })
    const customerId = await seedCustomer("Credit customer")
    await postSaleBalance(sale.saleId, customerId, sale.total)

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "goods returned unused",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(0)
    expect(Number(data?.receivable_reversal)).toBe(sale.total)
    expect(Number(data?.credit_balance_after)).toBe(0)
    expect((await ledger(customerId)).map((row) => row.type)).toEqual(["credit", "refund"])
  })

  it("a credit sale the customer had partly repaid leaves them in store credit", async () => {
    const inventory = await seedInventory("Repaid")
    const sale = await completeDiscountedSale(inventory, { paid: 0, method: "credit" })
    const customerId = await seedCustomer("Part-repaid customer")
    await postSaleBalance(sale.saleId, customerId, sale.total)

    const repayment = await db.rpc("post_pharmacy_credit_entry", {
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_type: "repayment",
      p_amount: 400,
      p_transaction_id: null,
      p_due_date: null,
      p_notes: "part payment before return",
      p_created_by: cashierId,
      p_idempotency_key: `repayment-${crypto.randomUUID()}`,
      p_payment_method: "cash",
    })
    expect(repayment.error).toBeNull()

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "goods returned after part payment",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(0)
    // The whole invoiced amount comes off, so the 400 already paid becomes a
    // balance the pharmacy owes the customer rather than disappearing.
    expect(Number(data?.credit_balance_after)).toBe(-400)
    const rows = await ledger(customerId)
    expect(rows.map((row) => [row.type, row.balance])).toEqual([
      ["credit", sale.total],
      ["repayment", sale.total - 400],
      ["refund", -400],
    ])
  })

  it("reports an unposted receivable instead of refunding cash that was never received", async () => {
    const inventory = await seedInventory("Unposted")
    const sale = await completeDiscountedSale(inventory, { paid: 0, method: "credit" })

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "credit posting had failed at sale time",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(0)
    expect(Number(data?.receivable_reversal)).toBe(0)
    expect(Number(data?.receivable_outstanding)).toBe(sale.total)
    expect(data?.receivable_unposted).toBe(true)
    expect(await saleStatus(sale.saleId)).toBe("voided")
  })

  it("never reverses more than the ledger actually holds, and names what it could not reverse", async () => {
    // A receivable row smaller than the sale's balance is what a partial or
    // hand-corrected posting leaves behind. The refund must reduce the
    // customer's balance by what is on the ledger — never more — and must say
    // how much of the debt the void left standing.
    const inventory = await seedInventory("ShortPosting")
    const sale = await completeDiscountedSale(inventory, { paid: 1000, method: "cash" })
    const customerId = await seedCustomer("Short posting customer")
    await postSaleBalance(sale.saleId, customerId, 500)

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "returned after a partial posting",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(1000)
    expect(Number(data?.receivable_outstanding)).toBe(900)
    expect(Number(data?.receivable_reversal)).toBe(500)
    expect(Number(data?.receivable_unreversed)).toBe(400)
    expect(data?.receivable_unposted).toBe(false)
    expect(Number(data?.credit_balance_after)).toBe(0)
    expect(await ledger(customerId)).toEqual([
      { type: "credit", amount: 500, balance: 500, key: `pos-sale:${sale.saleId}` },
      { type: "refund", amount: 500, balance: 0, key: `pos-refund:${sale.saleId}` },
    ])
  })

  it("treats a sale with no payment tag as fully paid, matching the reports", async () => {
    // complete-sale always writes the tag; a row that predates it or was
    // imported without one has no way to say otherwise. Both the RPC and the
    // refunds report decode it as fully paid, so the till and the report agree.
    const inventory = await seedInventory("NoTag")
    // No settlement argument leaves payment_ref null, which is what an imported
    // or pre-tag row carries.
    const sale = await completeDiscountedSale(inventory)

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "untagged sale return",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(sale.total)
    expect(Number(data?.receivable_reversal)).toBe(0)
    expect(Number(data?.receivable_unreversed)).toBe(0)
    expect(data?.receivable_unposted).toBe(false)
  })

  it("reports a sale that does not exist as a missing sale, not a missing product", async () => {
    // The caller uses this code to decide whether to search the older
    // transaction table. The sibling PRODUCT_NOT_FOUND branch — a line whose
    // product row is gone — cannot be provoked here because the sale-item
    // foreign key keeps that row present; it is covered at the route level.
    const { error } = await reversePharmacySale(db, {
      tenantId,
      saleId: crypto.randomUUID(),
      actorId: cashierId,
      reason: "probe",
    })
    expect(error?.code).toBe("SALE_NOT_FOUND")
  })

  it("posts exactly one refund movement no matter how often the refund is retried", async () => {
    const inventory = await seedInventory("RetryLedger")
    const sale = await completeDiscountedSale(inventory, { paid: 0, method: "credit" })
    const customerId = await seedCustomer("Retry customer")
    await postSaleBalance(sale.saleId, customerId, sale.total)

    const first = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "network retry probe",
    })
    const second = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "network retry probe",
    })

    expect(first.error).toBeNull()
    expect(second.error?.code).toBe("ALREADY_REFUNDED")
    const rows = await ledger(customerId)
    expect(rows.filter((row) => row.type === "refund")).toHaveLength(1)
    expect(rows.at(-1)?.balance).toBe(0)
  })

  it("refunds the recorded sale total, not the undiscounted line sum", async () => {
    const inventory = await seedInventory("Discounted")
    const sale = await completeDiscountedSale(inventory)
    expect(sale.total).toBe(1900)
    expect(await quantities(inventory)).toEqual({ product: 8, batch: 8 })

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "customer returned the purchase",
      restoreAs: "active",
    })

    expect(error).toBeNull()
    expect(Number(data?.refund_amount)).toBe(1900)
    expect(data?.status).toBe("voided")
    expect(await quantities(inventory)).toEqual({ product: 10, batch: 10 })
    expect(await saleStatus(sale.saleId)).toBe("voided")
  })

  it("refuses a second refund and does not restore stock twice", async () => {
    const inventory = await seedInventory("Double")
    const sale = await completeDiscountedSale(inventory)

    const first = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "duplicate execution probe",
    })
    expect(first.error).toBeNull()
    const afterFirst = await quantities(inventory)

    const second = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "duplicate execution probe",
    })

    expect(second.data).toBeNull()
    expect(second.error?.code).toBe("ALREADY_REFUNDED")
    expect(await quantities(inventory)).toEqual(afterFirst)
    expect(afterFirst).toEqual({ product: 10, batch: 10 })
  })

  it("serialises two concurrent refunds: one succeeds, stock comes back once", async () => {
    const inventory = await seedInventory("Concurrent")
    const sale = await completeDiscountedSale(inventory)
    expect(await quantities(inventory)).toEqual({ product: 8, batch: 8 })

    const attempt = () =>
      reversePharmacySale(db, {
        tenantId,
        saleId: sale.saleId,
        actorId: cashierId,
        reason: "double-tapped the refund button",
        restoreAs: "active",
      })
    // The SELECT ... FOR UPDATE on the sale row is what makes this safe: the
    // second caller blocks, then re-reads status = 'voided' under READ COMMITTED
    // and takes the ALREADY_REFUNDED path instead of restoring stock again.
    const [a, b] = await Promise.all([attempt(), attempt()])

    const succeeded = [a, b].filter((r) => !r.error)
    const refused = [a, b].filter((r) => r.error)
    expect(succeeded).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0].error?.code).toBe("ALREADY_REFUNDED")

    expect(await quantities(inventory)).toEqual({ product: 10, batch: 10 })
    expect(await saleStatus(sale.saleId)).toBe("voided")
  })

  it("does not reactivate recalled stock when a refund requests active restoration", async () => {
    const inventory = await seedInventory("RecalledBatch")
    const sale = await completeDiscountedSale(inventory)
    const recalledAt = new Date().toISOString()
    const { error: recallError } = await db
      .from("pharmacy_product_batches")
      .update({ status: "recalled", is_active: false, recalled_at: recalledAt })
      .eq("id", inventory.batchId)
      .eq("tenant_id", tenantId)
    expect(recallError).toBeNull()

    const unsafeRestore = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "recall must remain effective",
      restoreAs: "active",
    })
    expect(unsafeRestore.data).toBeNull()
    expect(unsafeRestore.error?.code).toBe("BATCH_NOT_RESTORABLE")
    expect(await saleStatus(sale.saleId)).toBe("completed")
    expect(await quantities(inventory)).toEqual({ product: 8, batch: 8 })

    const safeRestore = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "return recalled stock to restricted inventory",
      restoreAs: "quarantined",
    })
    expect(safeRestore.error).toBeNull()
    expect(await quantities(inventory)).toEqual({ product: 10, batch: 10 })

    const { data: batch, error: batchError } = await db
      .from("pharmacy_product_batches")
      .select("status, is_active, recalled_at")
      .eq("id", inventory.batchId)
      .eq("tenant_id", tenantId)
      .single()
    expect(batchError).toBeNull()
    expect(batch).toMatchObject({ status: "recalled", is_active: false })
    expect(batch.recalled_at).toBeTruthy()
  })

  it("refuses a refund whose actor belongs to another pharmacy", async () => {
    const inventory = await seedInventory("CrossTenantRefund")
    const sale = await completeDiscountedSale(inventory)
    const before = await quantities(inventory)

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: foreignActorId,
      reason: "cross-tenant probe",
    })

    expect(data).toBeNull()
    expect(error?.code).toBe("PERMISSION")
    expect(await quantities(inventory)).toEqual(before)
    expect(await saleStatus(sale.saleId)).toBe("completed")
  })

  it("refuses a stock adjustment whose actor belongs to another pharmacy", async () => {
    const inventory = await seedInventory("CrossTenantAdjust")
    const before = await quantities(inventory)

    const { data, error } = await adjustPharmacyBatchStock(db, {
      tenantId,
      productId: inventory.productId,
      quantity: 1,
      type: "DECREASE",
      reason: "cross-tenant probe",
      actorId: foreignActorId,
      batchId: inventory.batchId,
    })

    expect(data).toBeNull()
    expect(error?.code).toBe("PERMISSION")
    expect(await quantities(inventory)).toEqual(before)
  })

  it("refuses a decrease larger than the recorded product quantity without moving stock", async () => {
    const inventory = await seedInventory("Overshoot")
    const before = await quantities(inventory)

    const { data, error } = await adjustPharmacyBatchStock(db, {
      tenantId,
      productId: inventory.productId,
      quantity: before.product + 5,
      type: "DECREASE",
      reason: "overshoot probe",
      actorId: cashierId,
      batchId: inventory.batchId,
    })

    expect(data).toBeNull()
    expect(error?.code).toBe("INSUFFICIENT_STOCK")
    expect(await quantities(inventory)).toEqual(before)
  })

  it("refuses a decrease against a batch that no longer exists", async () => {
    const inventory = await seedInventory("MissingBatch")
    const before = await quantities(inventory)

    const { data, error } = await adjustPharmacyBatchStock(db, {
      tenantId,
      productId: inventory.productId,
      quantity: 1,
      type: "DECREASE",
      reason: "missing batch probe",
      actorId: cashierId,
      batchId: crypto.randomUUID(),
    })

    expect(data).toBeNull()
    expect(error?.code).toBe("BATCH_NOT_FOUND")
    expect(await quantities(inventory)).toEqual(before)
  })

  it("applies a batch correction exactly and audits it", async () => {
    const inventory = await seedInventory("Correction")

    const { data, error } = await adjustPharmacyBatchStock(db, {
      tenantId,
      productId: inventory.productId,
      quantity: 3,
      type: "CORRECTION",
      reason: "physical count",
      actorId: cashierId,
      batchId: inventory.batchId,
    })

    expect(error).toBeNull()
    expect(Number(data?.previous_qty)).toBe(10)
    expect(Number(data?.new_qty)).toBe(3)
    expect(await quantities(inventory)).toEqual({ product: 3, batch: 3 })

    const { data: audit, error: auditError } = await db
      .from("pharmacy_audit_logs")
      .select("action, profile_id")
      .eq("tenant_id", tenantId)
      .eq("action", "stock.correction")
      .eq("entity_id", inventory.batchId)
    expect(auditError).toBeNull()
    expect(audit).toHaveLength(1)
    expect(audit?.[0]?.profile_id).toBe(cashierId)
  })

  it("records every FEFO-decreased batch in stock adjustment history", async () => {
    const inventory = await seedInventory("FefoHistory")
    const secondBatchNumber = `B2-${crypto.randomUUID()}`
    const { error: receiveError } = await db.rpc("receive_pharmacy_stock", {
      p_tenant_id: tenantId,
      p_product_id: inventory.productId,
      p_batch_number: secondBatchNumber,
      p_quantity: 5,
      p_expiry_date: "2029-12-31",
      p_cost_price: 500,
      p_selling_price: inventory.price,
      p_received_by: cashierId,
      p_supplier_ref: "refund-rpc-test-fefo",
    })
    if (receiveError) throw new Error(receiveError.message)

    const { data: earlierBatch, error: batchError } = await db
      .from("pharmacy_product_batches")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("product_id", inventory.productId)
      .eq("batch_number", secondBatchNumber)
      .single()
    if (batchError) throw new Error(batchError.message)

    const reason = `FEFO history ${crypto.randomUUID()}`
    const { data, error } = await adjustPharmacyBatchStock(db, {
      tenantId,
      productId: inventory.productId,
      quantity: 12,
      type: "DECREASE",
      reason,
      actorId: cashierId,
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ previous_qty: 15, new_qty: 3, decreased: 12 })

    const { data: history, error: historyError } = await db
      .from("pharmacy_stock_adjustments")
      .select("batch_id, quantity, previous_qty, new_qty")
      .eq("tenant_id", tenantId)
      .eq("product_id", inventory.productId)
      .eq("type", "DECREASE")
      .eq("reason", reason)
      .order("previous_qty", { ascending: false })
    expect(historyError).toBeNull()
    expect(history).toEqual([
      {
        batch_id: earlierBatch.id,
        quantity: 5,
        previous_qty: 15,
        new_qty: 10,
      },
      {
        batch_id: inventory.batchId,
        quantity: 7,
        previous_qty: 10,
        new_qty: 3,
      },
    ])
  })

  it("rolls back an invalid refund completely, then accepts a valid retry", async () => {
    const inventory = await seedInventory("Rollback")
    const sale = await completeDiscountedSale(inventory)
    const before = await quantities(inventory)

    const { data, error } = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "invalid restore target probe",
      restoreAs: "sellable" as "active",
    })

    expect(data).toBeNull()
    expect(error?.code).toBe("INVALID_QUANTITY")
    expect(await quantities(inventory)).toEqual(before)
    expect(await saleStatus(sale.saleId)).toBe("completed")

    const retry = await reversePharmacySale(db, {
      tenantId,
      saleId: sale.saleId,
      actorId: cashierId,
      reason: "valid retry after refusal",
      restoreAs: "active",
    })
    expect(retry.error).toBeNull()
    expect(await quantities(inventory)).toEqual({ product: 10, batch: 10 })
  })

  it("refuses an adjustment without a reason", async () => {
    const inventory = await seedInventory("NoReason")
    const before = await quantities(inventory)

    const { data, error } = await adjustPharmacyBatchStock(db, {
      tenantId,
      productId: inventory.productId,
      quantity: 1,
      type: "DECREASE",
      reason: "   ",
      actorId: cashierId,
      batchId: inventory.batchId,
    })

    expect(data).toBeNull()
    expect(error?.code).toBe("INVALID_QUANTITY")
    expect(await quantities(inventory)).toEqual(before)
  })
})
