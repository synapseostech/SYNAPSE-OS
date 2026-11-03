import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isReceiptPrintSaleId,
  normalizePrintFailureReason,
  parseReceiptPrintOutcome,
  recordReceiptPrintOutcome,
  type ReceiptPrintDb,
} from "./receipt-print.ts"

const SALE_ID = "11111111-1111-4111-8111-111111111111"

type Call = { table: string; op: string; args: unknown[] }

function fakeDb(opts: {
  sale?: { data: unknown; error: unknown }
  updateError?: unknown
  auditError?: unknown
} = {}) {
  const calls: Call[] = []
  const updates: Record<string, unknown>[] = []
  const audits: Record<string, unknown>[] = []
  const inserts: Record<string, unknown>[] = []

  const client = {
    calls,
    updates,
    audits,
    from(table: string) {
      calls.push({ table, op: "from", args: [] })
      if (table === "pharmacy_pos_sales") {
        const chain: Record<string, unknown> = {}
        chain.update = (values: Record<string, unknown>) => {
          updates.push(values)
          return chain
        }
        chain.eq = (column: string, value: unknown) => {
          calls.push({ table, op: "eq", args: [column, value] })
          return chain
        }
        chain.select = () => chain
        chain.maybeSingle = async () =>
          opts.sale ?? {
            data: { id: SALE_ID, receipt_number: "POS-0001" },
            error: null,
          }
        return chain
      }
      return {
        async insert(row: Record<string, unknown>) {
          inserts.push(row)
          audits.push(row)
          return { error: opts.auditError ?? null }
        },
      }
    },
  }
  return {
    db: client as unknown as ReceiptPrintDb,
    calls,
    updates,
    audits,
  }
}

const baseInput = {
  tenantId: "tenant-1",
  profileId: "cashier-1",
  saleId: SALE_ID,
  outcome: "requested" as const,
}

describe("recordReceiptPrintOutcome", () => {
  it("records a print request in the sale row and audits it", async () => {
    const f = fakeDb()
    const result = await recordReceiptPrintOutcome(f.db, {
      ...baseInput,
      now: new Date("2026-11-01T10:00:00.000Z"),
    })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.receiptNumber, "POS-0001")
    assert.equal(result.outcome, "requested")
    assert.equal(result.printFailed, false)
    assert.equal(result.physicalPrintConfirmed, false)
    assert.equal(result.auditRecorded, true)
    assert.equal(result.attemptedAt, "2026-11-01T10:00:00.000Z")

    assert.deepEqual(f.updates, [{ print_failed: false, updated_at: "2026-11-01T10:00:00.000Z" }])
    assert.deepEqual(f.audits, [
      {
        tenant_id: "tenant-1",
        profile_id: "cashier-1",
        action: "POS_RECEIPT_PRINT_REQUESTED",
        entity: "POS_SALE",
        entity_id: SALE_ID,
        details: "receipt=POS-0001 outcome=requested",
      },
    ])
  })

  it("scopes the sale update to the caller's tenant", async () => {
    const f = fakeDb()
    await recordReceiptPrintOutcome(f.db, baseInput)
    const eqs = f.calls.filter((c) => c.op === "eq").map((c) => c.args)
    assert.deepEqual(eqs, [
      ["id", SALE_ID],
      ["tenant_id", "tenant-1"],
    ])
  })

  it("writes only print-tracking columns, never money, stock or status", async () => {
    const f = fakeDb()
    await recordReceiptPrintOutcome(f.db, baseInput)
    assert.deepEqual(Object.keys(f.updates[0]).sort(), ["print_failed", "updated_at"])
    assert.equal(f.updates[0].printed_at, undefined)
    const tables = [...new Set(f.calls.map((c) => c.table))]
    assert.deepEqual(tables.sort(), ["pharmacy_audit_logs", "pharmacy_pos_sales"])
  })

  it("records a failed print with the cashier's reason instead of hiding it", async () => {
    const f = fakeDb()
    const result = await recordReceiptPrintOutcome(f.db, {
      ...baseInput,
      outcome: "failed",
      reason: "  paper jam ",
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.printFailed, true)
    assert.equal(f.updates[0].print_failed, true)
    assert.equal(f.audits[0].action, "POS_RECEIPT_PRINT_FAILED")
    assert.equal(f.audits[0].details, "receipt=POS-0001 outcome=failed reason=paper jam")
  })

  it("never carries a stale reason into a successful request", async () => {
    const f = fakeDb()
    await recordReceiptPrintOutcome(f.db, { ...baseInput, reason: "paper jam" })
    assert.equal(f.audits[0].details, "receipt=POS-0001 outcome=requested")
  })

  it("reports a sale outside the tenant as not found and audits nothing", async () => {
    const f = fakeDb({ sale: { data: null, error: null } })
    const result = await recordReceiptPrintOutcome(f.db, baseInput)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.status, 404)
    assert.equal(result.code, "SALE_NOT_FOUND")
    assert.deepEqual(f.audits, [])
  })

  it("surfaces a database failure instead of claiming the print was recorded", async () => {
    const f = fakeDb({ sale: { data: null, error: { message: "connection reset" } } })
    const result = await recordReceiptPrintOutcome(f.db, baseInput)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.status, 500)
    assert.equal(result.code, "PRINT_STATUS_WRITE_FAILED")
    assert.deepEqual(f.audits, [])
  })

  it("reports audit failure without claiming the attempt was fully recorded", async () => {
    const f = fakeDb({ auditError: { message: "audit table unavailable" } })
    const result = await recordReceiptPrintOutcome(f.db, baseInput)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.status, 503)
    assert.equal(result.code, "PRINT_AUDIT_FAILED")
    assert.equal(result.attemptRecorded, true)
    assert.equal(result.outcome, "requested")
    // The sale row was still updated before the audit failed.
    assert.equal(f.updates.length, 1)
  })
})

describe("receipt print vocabulary", () => {
  it("accepts only the two outcomes a client can attest to", () => {
    assert.equal(parseReceiptPrintOutcome("requested"), "requested")
    assert.equal(parseReceiptPrintOutcome("failed"), "failed")
    assert.equal(parseReceiptPrintOutcome("printed"), null)
    assert.equal(parseReceiptPrintOutcome("success"), null)
    assert.equal(parseReceiptPrintOutcome(undefined), null)
  })

  it("defaults and caps the failure reason", () => {
    assert.equal(normalizePrintFailureReason("  paper jam "), "paper jam")
    assert.equal(normalizePrintFailureReason("   "), "printer unavailable")
    assert.equal(normalizePrintFailureReason(undefined), "printer unavailable")
    assert.equal(normalizePrintFailureReason("x".repeat(500)).length, 200)
  })

  it("rejects a malformed sale id before any query runs", () => {
    assert.equal(isReceiptPrintSaleId(SALE_ID), true)
    assert.equal(isReceiptPrintSaleId("not-a-uuid"), false)
    assert.equal(isReceiptPrintSaleId(null), false)
    assert.equal(isReceiptPrintSaleId(42), false)
  })
})
