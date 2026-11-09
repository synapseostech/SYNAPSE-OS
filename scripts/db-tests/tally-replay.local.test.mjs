// Real-database proof for the Tally replay write path.
//
// Runs only against the disposable Supabase stack that
// scripts/db-tests/run-pharmacy-db-harness.sh starts, never a remote project.
// It exercises the applied SQL itself — the movement RPC, the closing read and
// the compensating rollback — over PostgREST with the service role, which is
// how the apply stage calls them.
//
// What it proves, in order:
//   1. an inbound movement creates the batch and moves the product;
//   2. a second expiry for one batch number is refused without moving stock;
//   3. a differently named batch carries its own expiry;
//   3a. a receipt with no expiry is stored far-future while provenance keeps
//      the absence, so stock imported without expiry still functions;
//   4. an outbound movement leaves the named batch;
//   5. re-sending an applied movement changes nothing (idempotency barrier);
//   6. a movement past the stock on hand is refused;
//   7. the closing read returns the applied state in one payload;
//   8. rollback writes compensating movements, never deletes, and zeroes stock;
//   9. a fresh session can apply the same export after the rollback;
//  10. a sale can be completed from the imported batch with no Tally present
//      (the database half of AC-9);
//  11. rollback is then refused because post-cut-over trading exists;
//  12. the cut-over lease is granted on the first claim, serialises a duplicate
//      request and another session, and a stale row is free to take.
//
// What it does not prove: the portal, the bridge, sign-in, report rendering, or
// the full apply orchestration (chunks, storage, review gates). Those remain
// app-level checks and are reported separately.

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

const runId = randomUUID().slice(0, 8)
const tenantId = randomUUID()
const cashierId = randomUUID()
const session1 = randomUUID()
const session2 = randomUUID()
const session3 = randomUUID()
const productA = randomUUID()
const productB = randomUUID()
const COMPANY = `ZZ Tally Replay ${runId}`
const BATCH_A = `ZZ-PB-A-${runId}`
const BATCH_B = `ZZ-PB-B-${runId}`
const BATCH_C = `ZZ-PB-C-${runId}`
const EXPIRY_A = "2027-06-30"
const EXPIRY_B = "2027-01-31"
const RECEIVED = "2026-10-17"

// The cutoff the synthetic import closed at is "yesterday in Kampala", so the
// sale later in this suite is unambiguously post-cut-over trading without the
// assertion depending on a hard-coded date.
const KLA_TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date())
const THROUGH = new Date(`${KLA_TODAY}T00:00:00Z`)
THROUGH.setUTCDate(THROUGH.getUTCDate() - 1)
const THROUGH_DATE = THROUGH.toISOString().slice(0, 10)

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message ?? JSON.stringify(result.error)}`)
  return result.data
}

const KLA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
// received_date is timestamptz: the RPC stores local midnight in Kampala, which
// PostgREST serialises in UTC as the previous day at 21:00. The business day is
// what the assertion is about, so compare it in the pharmacy's zone.
const kampalaDate = (value) => KLA_DATE.format(new Date(value))

const rpc = (name, args) => db.rpc(name, args)

function movementArgs(sessionId, overrides) {
  return {
    p_tenant_id: tenantId,
    p_session_id: sessionId,
    p_movement_id: overrides.movementId,
    p_source_type: "tally_voucher",
    p_source_id: overrides.sourceId,
    p_source_guid: null,
    p_line_index: overrides.lineIndex ?? 0,
    p_movement_kind: overrides.kind,
    p_movement_date: overrides.date ?? RECEIVED,
    p_product_id: overrides.productId,
    p_allocation: overrides.allocation ?? "explicit",
    p_godown: "Main Location",
    p_allocations: overrides.allocations,
    p_allow_negative: false,
  }
}

const inbound = (sessionId, sourceId, batchNumber, expiryDate, quantity, productId = productA, date = RECEIVED) =>
  movementArgs(sessionId, {
    movementId: `${sourceId}:L0:B0`,
    sourceId,
    kind: "purchase_in",
    date,
    productId,
    allocations: [
      { batch_index: 0, batch_number: batchNumber, expiry_date: expiryDate, quantity_delta: quantity, rate: 1000, amount: quantity * 1000 },
    ],
  })

const outbound = (sessionId, sourceId, batchNumber, quantity, productId = productA, date = RECEIVED) =>
  movementArgs(sessionId, {
    movementId: `${sourceId}:L0:B0`,
    sourceId,
    kind: "sale_out",
    date,
    productId,
    allocations: [
      { batch_index: 0, batch_number: batchNumber, expiry_date: null, quantity_delta: -quantity, rate: 1000, amount: -quantity * 1000 },
    ],
  })

async function productQuantity(productId) {
  const { data } = await db.from("pharmacy_products").select("quantity").eq("id", productId).single()
  return Number(data.quantity)
}

async function batchRows(productId) {
  const { data } = await db
    .from("pharmacy_product_batches")
    .select("id, batch_number, expiry_date, quantity, received_date, status")
    .eq("tenant_id", tenantId)
    .eq("product_id", productId)
    .order("batch_number")
  return data ?? []
}

async function provenanceCount(sessionId) {
  const { count } = await db
    .from("pharmacy_tally_replay_movements")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("session_id", sessionId)
  return count ?? 0
}

describe("Tally replay write path (real PostgreSQL)", { skip }, () => {
  before(async () => {
    must(
      await db.from("tenants").insert({
        id: tenantId,
        slug: `zz-tally-${runId}`,
        name: `ZZ Tally Replay ${runId}`,
        facility_type: "pharmacy",
        district: "Kampala",
        is_active: true,
        status: "active",
        plan: "starter",
      }),
      "tenant",
    )
    must(
      await db.from("profiles").insert({
        id: cashierId,
        tenant_id: tenantId,
        email: `zz-tally-${runId}@example.invalid`,
        full_name: "ZZ Tally Cashier",
        role: "pharmacy_admin",
        verification_status: "verified",
        onboarding_complete: true,
      }),
      "profile",
    )
    must(
      await db.from("pharmacy_products").insert([
        {
          id: productA,
          tenant_id: tenantId,
          name: `ZZ Tally Item A ${runId}`,
          sku: `ZZT-A-${runId}`,
          price: 2000,
          cost_price: 1000,
          quantity: 0,
          unit_of_measure: "Tablet",
          category: "General",
        },
        {
          id: productB,
          tenant_id: tenantId,
          name: `ZZ Tally Item B ${runId}`,
          sku: `ZZT-B-${runId}`,
          price: 1500,
          cost_price: 700,
          quantity: 0,
          unit_of_measure: "Tablet",
          category: "General",
        },
      ]),
      "products",
    )
    for (const id of [session1, session2, session3]) {
      must(
        await db.from("pharmacy_import_sessions").insert({
          id,
          tenant_id: tenantId,
          source_system: "Tally",
          file_name: "synthetic-full-history.xml",
          status: "complete",
          total_rows: 3,
          matched_rows: 3,
          ai_mapping: { format: "xml", mode: "replay" },
        }),
        `session ${id}`,
      )
    }
  })

  after(async () => {
    if (!canRun) return
    // The harness destroys its database; this is for a declared acceptance
    // target. Best effort and reverse dependency order. A failure here is not a
    // test result and is not allowed to hide one.
    const swallow = async (promise) => {
      try {
        await promise
      } catch {
        /* cleanup best effort */
      }
    }
    await swallow(db.from("pharmacy_pos_sale_items").delete().eq("tenant_id", tenantId))
    await swallow(db.from("pharmacy_pos_sales").delete().eq("tenant_id", tenantId))
    await swallow(db.from("pharmacy_transactions").delete().eq("tenant_id", tenantId))
    await swallow(db.from("pharmacy_tally_replay_checkpoints").delete().eq("tenant_id", tenantId))
    // The lock names a session with ON DELETE RESTRICT; the lease test above
    // leaves one behind, so it goes before the sessions do.
    await swallow(db.from("pharmacy_tally_cutover_locks").delete().eq("tenant_id", tenantId))
    await swallow(db.from("pharmacy_import_sessions").delete().eq("tenant_id", tenantId))
    await swallow(db.from("pharmacy_product_batches").delete().eq("tenant_id", tenantId))
    await swallow(db.from("pharmacy_products").delete().eq("tenant_id", tenantId))
    await swallow(db.from("profiles").delete().eq("id", cashierId))
    await swallow(db.from("tenants").delete().eq("id", tenantId))
  })

  it("applies an inbound movement and creates the batch at its historical received date", async () => {
    const data = must(await rpc("apply_pharmacy_tally_replay_movement", inbound(session1, "M1", BATCH_A, EXPIRY_A, 100)), "M1")
    assert.equal(data.replayed, false)
    assert.equal(Number(data.product_quantity_after), 100)

    const rows = await batchRows(productA)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].batch_number, BATCH_A)
    assert.equal(rows[0].expiry_date, EXPIRY_A)
    assert.equal(Number(rows[0].quantity), 100)
    assert.equal(kampalaDate(rows[0].received_date), RECEIVED)
    assert.equal(rows[0].status, "active")
  })

  it("refuses a second expiry under the same batch number without moving any stock", async () => {
    const result = await rpc("apply_pharmacy_tally_replay_movement", inbound(session1, "M2", BATCH_A, "2027-09-30", 40))
    assert.ok(result.error, "a conflicting expiry must be refused")
    assert.match(result.error.message, /BATCH_EXPIRY_CONFLICT/)

    assert.equal(await productQuantity(productA), 100)
    const rows = await batchRows(productA)
    assert.equal(rows.length, 1, "the refusal must not leave a second batch behind")
    assert.equal(Number(rows[0].quantity), 100)
  })

  it("accepts a differently named batch with its own expiry", async () => {
    const data = must(await rpc("apply_pharmacy_tally_replay_movement", inbound(session1, "M3", BATCH_B, EXPIRY_B, 20)), "M3")
    assert.equal(data.replayed, false)
    assert.equal(Number(data.product_quantity_after), 120)

    const rows = await batchRows(productA)
    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((row) => [row.batch_number, row.expiry_date, Number(row.quantity)]),
      [
        [BATCH_A, EXPIRY_A, 100],
        [BATCH_B, EXPIRY_B, 20],
      ],
    )
  })

  it("stores a receipt with no expiry far-future and keeps the absence in provenance", async () => {
    const data = must(
      await rpc("apply_pharmacy_tally_replay_movement", inbound(session3, "N1", BATCH_C, null, 15, productB)),
      "no-expiry receipt",
    )
    assert.equal(Number(data.product_quantity_after), 15)

    const rows = await batchRows(productB)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].batch_number, BATCH_C)
    // The batch table requires a date; the replay records the true absence.
    assert.equal(rows[0].expiry_date, "9999-12-31")
    assert.equal(Number(rows[0].quantity), 15)

    const { data: provenance } = await db
      .from("pharmacy_tally_replay_movements")
      .select("expiry_date, allocation")
      .eq("tenant_id", tenantId)
      .eq("session_id", session3)
      .eq("source_id", "N1")
    assert.equal(provenance.length, 1)
    assert.equal(provenance[0].expiry_date, null)
    assert.equal(provenance[0].allocation, "explicit")
  })

  it("leaves the batch a sale names", async () => {
    const data = must(await rpc("apply_pharmacy_tally_replay_movement", outbound(session1, "M4", BATCH_A, 30)), "M4")
    assert.equal(data.replayed, false)
    assert.equal(Number(data.product_quantity_after), 90)

    const rows = await batchRows(productA)
    assert.deepEqual(
      rows.map((row) => [row.batch_number, Number(row.quantity)]),
      [
        [BATCH_A, 70],
        [BATCH_B, 20],
      ],
    )
  })

  it("re-sends an applied movement as a no-op", async () => {
    const before = await provenanceCount(session1)
    const data = must(await rpc("apply_pharmacy_tally_replay_movement", inbound(session1, "M1", BATCH_A, EXPIRY_A, 100)), "M1 repeat")
    assert.equal(data.replayed, true)
    assert.deepEqual(data.allocations, [])
    assert.equal(await provenanceCount(session1), before)
    assert.equal(await productQuantity(productA), 90)
  })

  it("refuses a movement that would take stock below zero", async () => {
    const result = await rpc("apply_pharmacy_tally_replay_movement", outbound(session1, "M5", BATCH_A, 500))
    assert.ok(result.error)
    assert.match(result.error.message, /REPLAY_NEGATIVE_STOCK/)
    assert.equal(await productQuantity(productA), 90)
  })

  it("returns the applied state from the closing read", async () => {
    const data = must(await rpc("pharmacy_tally_replay_actuals", { p_tenant_id: tenantId }), "actuals")
    const product = data.products.find((row) => row.product_id === productA)
    assert.equal(Number(product.quantity), 90)
    const batches = data.batches.filter((row) => row.product_id === productA)
    assert.deepEqual(
      batches.map((row) => [row.batch_number, Number(row.quantity)]),
      [
        [BATCH_A, 70],
        [BATCH_B, 20],
      ],
    )
  })

  it("rolls back by compensating movements and returns stock to zero", async () => {
    must(
      await db.from("pharmacy_tally_replay_checkpoints").insert({
        tenant_id: tenantId,
        company_key: COMPANY,
        session_id: session1,
        through_date: THROUGH_DATE,
        closing_state: { synthetic: true },
      }),
      "checkpoint 1",
    )

    const data = must(await rpc("reverse_pharmacy_tally_replay_session", { p_tenant_id: tenantId, p_session_id: session1 }), "rollback")
    assert.equal(Number(data.movements_reversed), 3)
    assert.equal(Number(data.products_updated), 1)

    assert.equal(await productQuantity(productA), 0)
    const rows = await batchRows(productA)
    assert.deepEqual(
      rows.map((row) => [row.batch_number, Number(row.quantity)]),
      [
        [BATCH_A, 0],
        [BATCH_B, 0],
      ],
    )

    const { data: reversals } = await db
      .from("pharmacy_tally_replay_movements")
      .select("source_type, reverses_movement_id")
      .eq("tenant_id", tenantId)
      .eq("session_id", session1)
      .eq("source_type", "tally_replay_reversal")
    assert.equal(reversals.length, 3)
    assert.ok(reversals.every((row) => row.reverses_movement_id))
  })

  it("lets a fresh session apply the same export after the rollback", async () => {
    must(await rpc("apply_pharmacy_tally_replay_movement", inbound(session2, "M1", BATCH_A, EXPIRY_A, 100)), "S2 M1")
    must(await rpc("apply_pharmacy_tally_replay_movement", inbound(session2, "M3", BATCH_B, EXPIRY_B, 20)), "S2 M3")
    must(await rpc("apply_pharmacy_tally_replay_movement", outbound(session2, "M4", BATCH_A, 30)), "S2 M4")

    assert.equal(await productQuantity(productA), 90)
    const rows = await batchRows(productA)
    assert.deepEqual(
      rows.map((row) => [row.batch_number, Number(row.quantity)]),
      [
        [BATCH_A, 70],
        [BATCH_B, 20],
      ],
    )
  })

  it("completes a sale from imported stock with no Tally connection (AC-9, database half)", async () => {
    const batches = await batchRows(productA)
    const batchA = batches.find((row) => row.batch_number === BATCH_A)
    assert.ok(batchA)

    const data = must(
      await rpc("complete_pharmacy_sale", {
        p_tenant_id: tenantId,
        p_cashier_id: cashierId,
        p_items: [{ product_id: productA, batch_id: batchA.id, quantity: 10, unit_price: 2000 }],
        p_payment_method: "CASH",
        p_session_id: null,
        p_cart_id: null,
        p_payment_ref: null,
        p_discount_total: 0,
        p_tax_amount: 0,
        p_patient_id: null,
        p_confirmed_by: cashierId,
        p_idempotency_key: `zz-tally-${runId}`,
      }),
      "sale",
    )
    assert.equal(data.status, "completed")
    assert.match(data.receipt_number, /^R-\d{8}-\d{4}$/)
    assert.equal(Number(data.total_amount), 20000)

    assert.equal(await productQuantity(productA), 80)
    const afterSale = await batchRows(productA)
    assert.equal(Number(afterSale.find((row) => row.batch_number === BATCH_A).quantity), 60)

    const { data: sale } = await db
      .from("pharmacy_pos_sales")
      .select("id, status, total_amount")
      .eq("tenant_id", tenantId)
      .eq("id", data.sale_id)
      .single()
    assert.equal(sale.status, "completed")
    assert.equal(Number(sale.total_amount), 20000)
  })

  it("refuses rollback once post-cut-over trading exists", async () => {
    must(
      await db.from("pharmacy_tally_replay_checkpoints").insert({
        tenant_id: tenantId,
        company_key: `${COMPANY} B`,
        session_id: session2,
        through_date: THROUGH_DATE,
        closing_state: { synthetic: true },
      }),
      "checkpoint 2",
    )

    const result = await rpc("reverse_pharmacy_tally_replay_session", { p_tenant_id: tenantId, p_session_id: session2 })
    assert.ok(result.error, "a rollback must not undo post-cut-over trading")
    assert.match(result.error.message, /TALLY_REVERSAL_ACTIVITY/)

    // Refusal writes nothing.
    assert.equal(await productQuantity(productA), 80)
    const { count } = await db
      .from("pharmacy_tally_replay_movements")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("session_id", session2)
      .eq("source_type", "tally_replay_reversal")
    assert.equal(count ?? 0, 0)
  })

  it("grants the first cut-over lease instead of refusing it as busy", async () => {
    const token = randomUUID()
    const claim = (sessionId, lease = token) =>
      rpc("claim_pharmacy_tally_cutover_apply", {
        p_tenant_id: tenantId,
        p_session_id: sessionId,
        p_lease_token: lease,
      })

    // The pharmacy's first claim used to insert its own token and then read it
    // back as a live lease, so every first apply was refused for fifteen
    // minutes. It must be granted.
    assert.equal(must(await claim(session1), "first claim"), "acquired")
    // A duplicate request from the same session is a concurrent apply.
    assert.equal(must(await claim(session1, randomUUID()), "duplicate claim"), "busy")
    // Another session may not take a live lease it does not continue.
    assert.equal(must(await claim(session2), "other session claim"), "owned_by_another_session")

    assert.equal(
      must(
        await rpc("release_pharmacy_tally_cutover_apply", {
          p_tenant_id: tenantId,
          p_session_id: session1,
          p_lease_token: token,
        }),
        "release",
      ),
      true,
    )

    // With no live lease the row is stale: a different session may take it
    // rather than being locked out of the pharmacy it is migrating.
    assert.equal(must(await claim(session2, randomUUID()), "stale takeover"), "acquired")
  })
})
