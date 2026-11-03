import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  reverse: vi.fn(),
  attach: vi.fn(async () => ({ ok: true })),
  update: vi.fn(),
  legacy: { current: null as Record<string, unknown> | null },
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({ ok: true, tenantId: "tenant-1", session: { user: { id: "manager-1" } } })),
}))
vi.mock("@/lib/api-serialize", () => ({ mapRefund: (r: unknown) => r }))
vi.mock("@synapse/db/inventory-rpc", () => ({ reversePharmacySale: m.reverse }))
vi.mock("@/lib/pos/till-service", () => ({ attachSaleToTill: m.attach }))
vi.mock("@/lib/supabase/admin", () => {
  const q: any = {
    select: () => q, eq: () => q,
    update: (...args: unknown[]) => { m.update(...args); return q },
    maybeSingle: async () => ({ data: { payment_method: "CASH", cashier_id: "cashier-9" }, error: null }),
    single: async () =>
      m.legacy.current
        ? { data: m.legacy.current, error: null }
        : { data: null, error: { message: "not found" } },
    insert: async () => ({ error: null }),
  }
  return { supabaseAdmin: { from: () => q } }
})

import { POST } from "./route"

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/admin/refunds", { method: "POST", body: JSON.stringify(body) }))

describe("POST /api/admin/refunds — till treatment", () => {
  beforeEach(() => {
    m.reverse.mockReset()
    m.attach.mockClear()
    m.update.mockClear()
    m.legacy.current = null
  })

  it("a committed refund reverses cash exactly once, keyed by the sale, for the original cashier", async () => {
    m.reverse.mockResolvedValue({ data: { refund_amount: 2500 }, error: null })
    const res = await post({ saleId: "sale-1", reason: "Wrong item" })
    expect(res.status).toBe(200)
    expect(m.attach).toHaveBeenCalledTimes(1)
    expect(m.attach).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "refund", amount: 2500, sourceId: "refund:sale-1", cashierId: "cashier-9", tenantId: "tenant-1" }),
    )
  })

  it("an already-refunded sale (retry) is refused and touches no cash", async () => {
    m.reverse.mockResolvedValue({ data: null, error: { code: "ALREADY_REFUNDED", humanMessage: "Already refunded" } })
    const res = await post({ saleId: "sale-1", reason: "Wrong item" })
    expect(res.status).toBe(409)
    expect(m.attach).not.toHaveBeenCalled()
  })

  it("a failed reversal touches no cash", async () => {
    m.reverse.mockResolvedValue({ data: null, error: { code: "DB_ERROR", humanMessage: "Failed" } })
    const res = await post({ saleId: "sale-1", reason: "Wrong item" })
    expect(res.status).toBe(400)
    expect(m.attach).not.toHaveBeenCalled()
  })

  it("a refund without a reason is rejected before any reversal or cash", async () => {
    const res = await post({ saleId: "sale-1" })
    expect(res.status).toBe(400)
    expect(m.reverse).not.toHaveBeenCalled()
    expect(m.attach).not.toHaveBeenCalled()
  })

  it("a credit sale hands back no cash and reports the receivable it reversed", async () => {
    m.reverse.mockResolvedValue({
      data: {
        refund_amount: 0,
        receivable_reversal: 9000,
        receivable_outstanding: 9000,
        receivable_unposted: false,
        credit_balance_after: 0,
      },
      error: null,
    })
    const res = await post({ saleId: "sale-2", reason: "Customer returned goods" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.refundAmount).toBe(0)
    expect(body.receivableReversal).toBe(9000)
    expect(body.creditBalanceAfter).toBe(0)
    expect(body.receivableUnposted).toBe(false)
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ kind: "refund", amount: 0 }))
  })

  it("refuses a POS sale whose product line lost its catalogue row instead of faking a missing transaction", async () => {
    m.reverse.mockResolvedValue({
      data: null,
      error: { code: "PRODUCT_NOT_FOUND", humanMessage: "Product was not found in this pharmacy." },
    })
    const res = await post({ saleId: "sale-1", reason: "Wrong item" })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("PRODUCT_NOT_FOUND")
    expect(body.error).toContain("no longer exists")
    expect(m.attach).not.toHaveBeenCalled()
  })

  it("falls back to the older transaction table only when no POS sale has that id", async () => {
    m.reverse.mockResolvedValue({
      data: null,
      error: { code: "SALE_NOT_FOUND", humanMessage: "This sale was not found in this pharmacy." },
    })
    const res = await post({ saleId: "sale-1", reason: "Wrong item" })
    // The legacy lookup fails in this fixture, so the operator gets its 404 —
    // the fallback was attempted rather than the POS error being shown.
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Transaction not found")
  })

  it("refuses to refund a sale imported from Tally instead of rewriting its history", async () => {
    m.reverse.mockResolvedValue({ data: null, error: { code: "SALE_NOT_FOUND", humanMessage: "nope" } })
    m.legacy.current = {
      id: "tx-imported",
      transaction_no: "TALLY-1",
      status: "COMPLETED",
      notes: "Imported from Tally (Test Company) — read-only",
      total_amount: 1000,
      discount: 0,
      tax: 0,
      net_amount: 1000,
      items: [{ id: "a", product_id: "p1", unit_price: 1000, quantity: 1 }],
    }

    const res = await post({ transactionId: "tx-imported", reason: "Wrong item" })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("TALLY_MIRROR_READ_ONLY")
    expect(m.update).not.toHaveBeenCalled()
  })

  it("reports the part of the balance the ledger could not reverse", async () => {
    m.reverse.mockResolvedValue({
      data: {
        refund_amount: 1000,
        receivable_reversal: 500,
        receivable_outstanding: 900,
        receivable_unreversed: 400,
        receivable_unposted: false,
      },
      error: null,
    })
    const res = await post({ saleId: "sale-4", reason: "Wrong item" })
    const body = await res.json()
    expect(body.receivableReversal).toBe(500)
    expect(body.receivableUnreversed).toBe(400)
  })

  it("a discounted, taxed order refunds what was paid, not the line-price sum", async () => {
    m.reverse.mockResolvedValue({ data: null, error: { code: "SALE_NOT_FOUND", humanMessage: "nope" } })
    m.legacy.current = {
      id: "tx-1",
      transaction_no: "ORD-1",
      status: "COMPLETED",
      notes: null,
      total_amount: 1300,
      discount: 200,
      tax: 198,
      net_amount: 1298,
      items: [
        { id: "a", product_id: "p1", unit_price: 500, quantity: 2 },
        { id: "b", product_id: "p2", unit_price: 300, quantity: 1 },
      ],
    }

    const res = await post({ transactionId: "tx-1", reason: "Customer returned goods" })
    expect(res.status).toBe(200)
    const body = await res.json()
    // The old line-sum refunded 1300 here: 2 UGX over what the customer paid.
    expect(body.refundAmount).toBe(1298)
    expect(body.source).toBe("order")
    expect(m.attach).not.toHaveBeenCalled()
  })

  it("an order refund credits nothing to the till — no cash moves in the app", async () => {
    m.reverse.mockResolvedValue({ data: null, error: { code: "SALE_NOT_FOUND", humanMessage: "nope" } })
    m.legacy.current = {
      id: "tx-2",
      transaction_no: "ORD-2",
      status: "COMPLETED",
      notes: null,
      total_amount: 1000,
      discount: 0,
      tax: 180,
      net_amount: 1180,
      items: [{ id: "a", product_id: "p1", unit_price: 1000, quantity: 1 }],
    }

    const res = await post({ transactionId: "tx-2", reason: "Wrong item" })
    expect((await res.json()).refundAmount).toBe(1180)
    expect(m.attach).not.toHaveBeenCalled()
  })

  it("a sale whose balance was never posted is reported as unposted", async () => {
    m.reverse.mockResolvedValue({
      data: { refund_amount: 2000, receivable_reversal: 0, receivable_outstanding: 6000, receivable_unposted: true },
      error: null,
    })
    const res = await post({ saleId: "sale-3", reason: "Wrong item" })
    const body = await res.json()
    expect(body.refundAmount).toBe(2000)
    expect(body.receivableReversal).toBe(0)
    expect(body.receivableUnposted).toBe(true)
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000 }))
  })
})
