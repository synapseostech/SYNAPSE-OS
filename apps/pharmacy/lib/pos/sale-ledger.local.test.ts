/**
 * Sale history proof against a LOCAL Supabase (skipped unless LOCAL_API_URL is 127.0.0.1/localhost).
 * Order -> payment -> complete_pharmacy_sale persists the sale -> it appears exactly once in
 * sale history (listLedgerSalesForHistory), recent sales and the revenue report, including after
 * a retry with the same idempotency key.
 */
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { beforeAll, describe, expect, it } from "vitest"

const URL_ = process.env.LOCAL_API_URL ?? ""
const KEY = process.env.LOCAL_SERVICE_ROLE_KEY ?? ""
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(URL_) && KEY.length > 0
if (isLocal) {
  process.env.SUPABASE_URL = URL_
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY
}

describe.skipIf(!isLocal)("sale history (local Postgres)", () => {
  const db = isLocal ? createClient(URL_, KEY, { auth: { persistSession: false } }) : (null as never)
  let tenantId = ""
  let cashierId = ""
  let productId = ""
  let batchId = ""
  const startIso = new Date(Date.now() - 1000).toISOString()

  beforeAll(async () => {
    const { data: t } = await db.from("tenants").select("id").ilike("name", "ZZ Synthetic Pharmacy%").order("created_at").limit(1).single()
    tenantId = t!.id
    const { data: prof } = await db.from("profiles").select("id").eq("tenant_id", tenantId).limit(1).single()
    cashierId = prof!.id
    const { data: p, error } = await db.from("pharmacy_products").insert({
      tenant_id: tenantId, name: `ZZ history ${randomUUID().slice(0, 6)}`, sku: `ZZH-${randomUUID().slice(0, 8)}`,
      price: 1500, cost_price: 500, quantity: 10, category: "General", unit_of_measure: "Tablet",
    }).select("id").single()
    if (error) throw error
    productId = p.id
    const today = new Date().toISOString().slice(0, 10)
    const { data: batch, error: be } = await db.from("pharmacy_product_batches").insert({
      tenant_id: tenantId, product_id: productId, batch_number: `ZZHB-${randomUUID().slice(0, 6)}`, quantity: 10,
      initial_quantity: 10, expiry_date: new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10),
      received_date: today, cost_price: 500, selling_price: 1500, is_active: true, status: "active",
    }).select("id").single()
    if (be) throw be
    batchId = batch.id
  })

  it("a paid sale is persisted once and shows exactly once in history, recent sales and revenue", async () => {
    const { listLedgerSalesForHistory, listRecentLedgerSales, sumCompletedRevenue } = await import("./sale-ledger")
    const before = await sumCompletedRevenue({ tenantId, fromIso: startIso })
    const key = `history-proof-${randomUUID()}`
    const args = {
      p_tenant_id: tenantId, p_cashier_id: cashierId,
      p_items: [{ product_id: productId, batch_id: batchId, quantity: 2, unit_price: 1500 }],
      p_payment_method: "CASH", p_session_id: null, p_cart_id: null, p_payment_ref: `pay-${key}`, p_discount_total: 0,
      p_tax_amount: 0, p_patient_id: null, p_confirmed_by: cashierId, p_idempotency_key: key,
    }
    const first = await db.rpc("complete_pharmacy_sale", args)
    expect(first.error).toBeNull()
    const saleId = (first.data as { sale_id: string }).sale_id
    // Client retry of the same payment (same idempotency key) must not create a second sale.
    const retry = await db.rpc("complete_pharmacy_sale", args)
    expect(retry.error).toBeNull()
    expect((retry.data as { sale_id: string }).sale_id).toBe(saleId)

    const history = await listLedgerSalesForHistory({ tenantId, fromIso: startIso, limit: 500 })
    const matches = history.filter((r) => r.id === saleId)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ source: "pos", netAmount: 3000 })
    expect(matches[0].items).toHaveLength(1)

    const recent = await listRecentLedgerSales({ tenantId, limit: 50 })
    expect(recent.filter((r) => r.id === saleId)).toHaveLength(1)

    const after = await sumCompletedRevenue({ tenantId, fromIso: startIso })
    expect(after.count - before.count).toBe(1)
    expect(after.amount - before.amount).toBe(3000)

    const { data: stock } = await db.from("pharmacy_products").select("quantity").eq("id", productId).single()
    expect(stock!.quantity).toBe(8)
  })
})
