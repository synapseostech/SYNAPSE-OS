// Real-concurrency tests against a disposable Supabase (PostgREST -> Postgres).
// Runs on 127.0.0.1/localhost, or on a remote project only when the caller
// declared it with SYNAPSE_PHARMACY_DB_REMOTE=1 and
// SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF matching the URL. Production is refused.
// Run: source <env with supabase status -o env> && node --test scripts/db-tests/pharmacy-concurrency.local.test.mjs
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const URL_ = process.env.LOCAL_API_URL ?? ""
const KEY = process.env.LOCAL_SERVICE_ROLE_KEY ?? ""
const PRODUCTION_REF = "qfqakzmjatszisuqjwon"
const DECLARED_ACCEPTANCE_REF = (process.env.SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF ?? "").trim().toLowerCase()
const hostRef = (() => {
  try {
    return new URL(URL_).hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1] ?? ""
  } catch {
    return ""
  }
})()
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(URL_) && KEY.length > 0
const isDeclaredRemote =
  process.env.SYNAPSE_PHARMACY_DB_REMOTE === "1" &&
  Boolean(DECLARED_ACCEPTANCE_REF) &&
  DECLARED_ACCEPTANCE_REF !== PRODUCTION_REF &&
  hostRef === DECLARED_ACCEPTANCE_REF
const canRun = (isLocal || isDeclaredRemote) && KEY.length > 0
const skip = canRun ? false : "no disposable Supabase target (local 127.0.0.1 or a declared remote acceptance project)"
const db = canRun ? createClient(URL_, KEY, { auth: { persistSession: false } }) : null
const suiteLabel = isLocal
  ? "pharmacy concurrency (local Postgres)"
  : isDeclaredRemote
    ? "pharmacy concurrency (declared acceptance project)"
    : "pharmacy concurrency (disposable Supabase)"

let tenantId = ""
let cashierId = ""
const created = { products: [], customers: [], sessions: [] }
const today = new Date().toISOString().slice(0, 10)
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)

async function product(qty, label) {
  const { data: p, error } = await db.from("pharmacy_products").insert({
    tenant_id: tenantId, name: `ZZ conc ${label} ${randomUUID().slice(0, 6)}`, sku: `ZZC-${randomUUID().slice(0, 8)}`,
    price: 1000, cost_price: 500, quantity: qty, category: "General", unit_of_measure: "Tablet",
  }).select("id").single()
  if (error) throw error
  let batchId = null
  if (qty > 0) {
    const { data: b, error: be } = await db.from("pharmacy_product_batches").insert({
      tenant_id: tenantId, product_id: p.id, batch_number: `ZZB-${randomUUID().slice(0, 6)}`, quantity: qty,
      initial_quantity: qty, expiry_date: inDays(300), received_date: today, cost_price: 500, is_active: true, status: "active",
    }).select("id").single()
    if (be) throw be
    batchId = b.id
  }
  created.products.push(p.id)
  return { productId: p.id, batchId }
}

// complete_pharmacy_sale requires each line to name its priced batch; only an
// overdraft line may omit it.
const sell = (productId, batchId, quantity, extra = {}) =>
  db.rpc("complete_pharmacy_sale", {
    p_tenant_id: tenantId, p_cashier_id: cashierId,
    p_items: [{ product_id: productId, batch_id: batchId, quantity, unit_price: 1000 }],
    p_payment_method: "CASH", p_session_id: null, p_cart_id: null, p_payment_ref: null, p_discount_total: 0,
    p_tax_amount: 0, p_patient_id: null, p_confirmed_by: cashierId, p_idempotency_key: null, ...extra,
  })

describe(suiteLabel, { skip }, () => {
  before(async () => {
    const { data: t } = await db.from("tenants").select("id, name").ilike("name", "ZZ Synthetic Pharmacy%").order("created_at").limit(1).maybeSingle()
    assert.ok(t, "needs a provisioned ZZ Synthetic Pharmacy acceptance tenant")
    tenantId = t.id
    const { data: prof } = await db.from("profiles").select("id").eq("tenant_id", tenantId).limit(1).single()
    cashierId = prof.id
  })

  after(async () => {
    // Synthetic rows stay for audit; products are deactivated so they do not pollute the catalogue.
    if (created.products.length) await db.from("pharmacy_products").update({ is_active: false }).in("id", created.products)
  })

  it("last unit: two concurrent cashiers each sell 1 of stock 1 -> exactly one succeeds", async () => {
    const { productId: pid, batchId } = await product(1, "last-unit")
    const [a, b] = await Promise.all([sell(pid, batchId, 1), sell(pid, batchId, 1)])
    const ok = [a, b].filter((r) => !r.error)
    const failed = [a, b].filter((r) => r.error)
    assert.equal(ok.length, 1, "exactly one sale commits")
    assert.equal(failed.length, 1)
    assert.match(failed[0].error.message, /^INSUFFICIENT_STOCK/)
    const { data: p } = await db.from("pharmacy_products").select("quantity").eq("id", pid).single()
    assert.equal(p.quantity, 0)
    const { data: neg } = await db.from("pharmacy_product_batches").select("id").eq("product_id", pid).eq("batch_number", "NEG-STOCK")
    assert.equal(neg.length, 0, "no NEG-STOCK overdraft batch")
  })

  it("oversell (99,999 of stock 5) is rejected and stock is untouched", async () => {
    const { productId: pid, batchId } = await product(5, "oversell")
    const r = await sell(pid, batchId, 99999)
    assert.ok(r.error)
    assert.match(r.error.message, /^INSUFFICIENT_STOCK/)
    const { data: p } = await db.from("pharmacy_products").select("quantity").eq("id", pid).single()
    assert.equal(p.quantity, 5)
  })

  it("duplicate retry with the same idempotency key creates one sale", async () => {
    const { productId: pid, batchId } = await product(10, "idem")
    const key = `zz-idem-${randomUUID()}`
    const rs = await Promise.all([1, 2, 3].map(() => sell(pid, batchId, 2, { p_idempotency_key: key })))
    const ok = rs.filter((r) => !r.error)
    assert.ok(ok.length >= 1)
    const saleIds = new Set(ok.map((r) => r.data.sale_id))
    assert.equal(saleIds.size, 1, "all successful replies point at one sale")
    for (const r of rs.filter((x) => x.error)) assert.match(r.error.message, /IDEMPOTENCY_IN_PROGRESS/)
    const { data: p } = await db.from("pharmacy_products").select("quantity").eq("id", pid).single()
    assert.equal(p.quantity, 8, "stock decremented once")
  })

  // ── Credit ledger (post_pharmacy_credit_entry) ─────────────────────────────
  const customer = async () => {
    const { data, error } = await db.from("pharmacy_customers").insert({
      tenant_id: tenantId, name: `ZZ conc customer ${randomUUID().slice(0, 6)}`,
      email: `zz-conc-${randomUUID().slice(0, 8)}@example.test`, phone: null, is_active: true,
    }).select("id").single()
    if (error) throw error
    return data.id
  }
  const post = (customerId, type, amount, key = null) =>
    db.rpc("post_pharmacy_credit_entry", {
      p_tenant_id: tenantId, p_customer_id: customerId, p_type: type, p_amount: amount,
      p_transaction_id: null, p_due_date: null, p_notes: "zz concurrency", p_created_by: cashierId, p_idempotency_key: key,
    })
  const balanceOf = async (customerId) => {
    const { data } = await db.from("pharmacy_credit_ledger").select("type, amount, balance_after, created_at, id")
      .eq("tenant_id", tenantId).eq("customer_id", customerId).order("created_at", { ascending: true }).order("id")
    const sum = data.reduce((s, r) => s + (r.type === "credit" ? 1 : -1) * Number(r.amount), 0)
    return { rows: data, sum, last: data.length ? Number(data[data.length - 1].balance_after) : 0 }
  }

  it("ten concurrent credits: final balance equals the sum of committed postings", async () => {
    const c = await customer()
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(c, "credit", 100)))
    assert.equal(rs.filter((r) => r.error).length, 0)
    const b = await balanceOf(c)
    assert.equal(b.rows.length, 10)
    assert.equal(b.last, 1000)
    assert.equal(b.sum, 1000)
    // running balances form an unbroken chain 100, 200, ... 1000
    assert.deepEqual(b.rows.map((r) => Number(r.balance_after)), [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
  })

  it("two simultaneous repayments that together overpay: exactly one commits", async () => {
    const c = await customer()
    await post(c, "credit", 1000)
    const [a, b2] = await Promise.all([post(c, "repayment", 600), post(c, "repayment", 600)])
    const ok = [a, b2].filter((r) => !r.error)
    assert.equal(ok.length, 1)
    assert.match([a, b2].find((r) => r.error).error.message, /^OVERPAYMENT/)
    const b = await balanceOf(c)
    assert.equal(b.last, 400)
    assert.equal(b.sum, 400)
  })

  it("sale credit and repayment at the same time: both commit, balance is consistent", async () => {
    const c = await customer()
    await post(c, "credit", 500)
    const rs = await Promise.all([post(c, "credit", 300), post(c, "repayment", 200)])
    assert.equal(rs.filter((r) => r.error).length, 0)
    const b = await balanceOf(c)
    assert.equal(b.last, 600)
    assert.equal(b.sum, 600)
  })

  it("duplicate callback/retry with the same key posts once", async () => {
    const c = await customer()
    await post(c, "credit", 1000)
    const key = `zz-repay-${randomUUID()}`
    const rs = await Promise.all([1, 2, 3, 4].map(() => post(c, "repayment", 250, key)))
    assert.equal(rs.filter((r) => r.error).length, 0)
    assert.equal(new Set(rs.map((r) => r.data.id)).size, 1, "every reply is the same ledger row")
    assert.equal(rs.filter((r) => r.data.replayed === false).length, 1)
    const b = await balanceOf(c)
    assert.equal(b.rows.length, 2)
    assert.equal(b.last, 750)
  })

  it("foreign-tenant customer is refused", async () => {
    const r = await db.rpc("post_pharmacy_credit_entry", {
      p_tenant_id: tenantId, p_customer_id: randomUUID(), p_type: "credit", p_amount: 1,
    })
    assert.match(r.error?.message ?? "", /^CUSTOMER_NOT_FOUND/)
  })

  // ── Till cash (pharmacy_till_record_cash) ───────────────────────────────────
  const session = async () => {
    const { data, error } = await db.from("pharmacy_cashier_sessions").insert({
      tenant_id: tenantId, cashier_id: cashierId, opened_by: cashierId, status: "closed", opening_float: 0,
    }).select("id").single()
    if (error) throw error
    return data.id
  }
  const cash = (sessionId, kind, amount, source) =>
    db.rpc("pharmacy_till_record_cash", { p_tenant_id: tenantId, p_session_id: sessionId, p_kind: kind, p_amount: amount, p_source_id: source, p_actor_id: cashierId })

  it("concurrent till writes: totals equal the sum of unique committed events", async () => {
    const sid = await session()
    const sales = Array.from({ length: 20 }, (_, i) => cash(sid, "sale", 100, `sale:${sid}:${i}`))
    const dupes = Array.from({ length: 5 }, () => cash(sid, "sale", 999, `sale:${sid}:dup`))
    const moves = [cash(sid, "cash_in", 50, null), cash(sid, "cash_out", 30, null), cash(sid, "refund", 100, `refund:${sid}:0`), cash(sid, "refund", 100, `refund:${sid}:0`)]
    const rs = await Promise.all([...sales, ...dupes, ...moves])
    assert.equal(rs.filter((r) => r.error).length, 0)
    assert.equal(rs.slice(20, 25).filter((r) => r.data.applied).length, 1, "duplicate source applied once")
    const { data: s } = await db.from("pharmacy_cashier_sessions").select("cash_payment_total, cash_refund_total, cash_in, cash_out").eq("id", sid).single()
    const { data: ev } = await db.from("pharmacy_till_cash_events").select("kind, amount").eq("session_id", sid)
    const sum = (k) => ev.filter((e) => e.kind === k).reduce((a, e) => a + Number(e.amount), 0)
    assert.equal(Number(s.cash_payment_total), 2000 + 999)
    assert.equal(Number(s.cash_payment_total), sum("sale"))
    assert.equal(Number(s.cash_refund_total), 100)
    assert.equal(Number(s.cash_refund_total), sum("refund"))
    assert.equal(Number(s.cash_in), 50)
    assert.equal(Number(s.cash_out), 30)
  })

  it("zero / failed amount records no cash event", async () => {
    const sid = await session()
    const r = await cash(sid, "sale", 0, `sale:${sid}:zero`)
    assert.equal(r.data.applied, false)
    const { data: ev } = await db.from("pharmacy_till_cash_events").select("id").eq("session_id", sid)
    assert.equal(ev.length, 0)
  })

  it("duplicate Flutterwave confirmation (webhook + redirect, concurrent): one activation, one event", async () => {
    const { data: plan } = await db.from("subscription_plans").select("id").eq("slug", "synapse_pharmacy_annual").maybeSingle()
    const periodEnd = new Date(Date.now() + 365 * 864e5).toISOString()
    const { data: pay, error } = await db.from("subscription_payments").insert({
      tenant_id: tenantId, plan_id: plan?.id ?? null, amount_ugx: 240000, provider_tx_ref: `ZZ-FLW-${randomUUID()}`,
      status: "pending", period_start: new Date().toISOString(), period_end: periodEnd,
    }).select("id").single()
    if (error) throw error
    const since = new Date(Date.now() - 1000).toISOString()
    const results = await Promise.all(Array.from({ length: 4 }, () => db.rpc("activate_subscription_payment", { p_payment_id: pay.id, p_actor: "test" })))
    for (const r of results) assert.equal(r.error, null)
    assert.equal(results.filter((r) => r.data.ok && !r.data.idempotent).length, 1, "exactly one real activation")
    assert.equal(results.filter((r) => r.data.idempotent).length, 3)
    const { data: events } = await db.from("subscription_events").select("id, metadata").eq("tenant_id", tenantId).gte("created_at", since)
    assert.equal((events ?? []).filter((e) => e.metadata?.payment_id === pay.id).length, 1)
    const { data: sub } = await db.from("tenant_subscriptions").select("current_period_end").eq("tenant_id", tenantId).single()
    assert.equal(new Date(sub.current_period_end).toISOString(), periodEnd)
  })
})
