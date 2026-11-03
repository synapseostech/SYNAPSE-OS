import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  ledger: vi.fn(),
  revenue: vi.fn(async () => ({ amount: 0, count: 0 })),
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({
    ok: true,
    tenantId: "tenant-1",
    session: { user: { id: "manager-1" } },
  })),
  requirePharmacyAdmin: vi.fn(async () => ({
    ok: true,
    tenantId: "tenant-1",
    session: { user: { id: "manager-1" } },
  })),
}))
vi.mock("@/lib/pos/sale-ledger", () => ({
  listLedgerSalesForHistory: m.ledger,
  sumCompletedRevenue: m.revenue,
}))
vi.mock("@/lib/supabase/admin", () => {
  const q: any = { select: () => q, delete: () => q, eq: () => q, insert: async () => ({ error: null }) }
  return { supabaseAdmin: { from: () => q } }
})

import { GET } from "./route"

const row = (over: Record<string, unknown> = {}) => ({
  id: "sale-1",
  source: "pos" as const,
  transactionNo: "R-0001",
  status: "COMPLETED",
  netAmount: 120,
  subtotal: 120,
  discount: 0,
  tax: 0,
  paymentMethod: "CASH",
  paymentRef: null as string | null,
  cashierId: "cashier-1",
  cashierName: "Amina",
  createdAt: "2026-11-01T10:00:00.000Z",
  clientName: null,
  notes: null,
  printFailed: false,
  items: [],
  ...over,
})

const get = (search?: string) =>
  GET(
    new NextRequest(
      `http://localhost/api/admin/transactions${search == null ? "" : `?search=${encodeURIComponent(search)}`}`,
    ),
  )

describe("GET /api/admin/transactions", () => {
  beforeEach(() => {
    m.ledger.mockReset()
    m.ledger.mockResolvedValue([row()])
    m.revenue.mockClear()
  })

  it("forwards the receipt search to the ledger instead of returning the newest sale", async () => {
    const res = await get("R-0003")
    expect(res.status).toBe(200)
    expect(m.ledger).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", search: "R-0003" }))
  })

  it("sends no search filter when the box is empty", async () => {
    await get("")
    expect(m.ledger).toHaveBeenCalledWith(expect.objectContaining({ search: undefined }))
  })

  it("keeps the sale status so a refunded sale can hide its refund button", async () => {
    m.ledger.mockResolvedValue([row({ status: "REFUNDED" })])
    const body = await (await get()).json()
    expect(body.transactions[0].status).toBe("REFUNDED")
  })

  it("reports cash paid and customer credit separately for a partially paid POS sale", async () => {
    m.ledger.mockResolvedValue([
      row({ netAmount: 120, paymentRef: "PAID:40|BAL:80|M:CASH" }),
    ])
    const body = await (await get()).json()
    expect(body.transactions[0]).toMatchObject({ paidAmount: 40, balanceDue: 80 })
  })

  it("treats an untagged cash sale as fully paid and an untagged credit sale as entirely owed", async () => {
    m.ledger.mockResolvedValue([
      row({ id: "cash", netAmount: 500, paymentMethod: "CASH", paymentRef: null }),
      row({ id: "credit", netAmount: 120, paymentMethod: "CREDIT", paymentRef: null }),
    ])
    const body = await (await get()).json()
    const byId = Object.fromEntries(body.transactions.map((t: any) => [t.id, t]))
    expect(byId.cash).toMatchObject({ paidAmount: 500, balanceDue: 0 })
    expect(byId.credit).toMatchObject({ paidAmount: 0, balanceDue: 120 })
  })

  it("a legacy order refunds its header: paid = subtotal - discount + tax, no credit balance", async () => {
    m.ledger.mockResolvedValue([
      row({ source: "order", transactionNo: "TXN-1", subtotal: 1000, discount: 100, tax: 180, netAmount: 1080 }),
    ])
    const body = await (await get()).json()
    expect(body.transactions[0]).toMatchObject({ paidAmount: 1080, balanceDue: 0 })
  })
})
