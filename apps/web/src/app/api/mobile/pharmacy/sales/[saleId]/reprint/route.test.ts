import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  snapshots: [] as Array<{ tenantId: string; saleId: string; opts: unknown }>,
  events: [] as Array<Record<string, unknown>>,
}))

vi.mock("../../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => m.auth(...args),
  isMobileAuth: (value: any) => Boolean(value && value.userId),
}))

vi.mock("../../../../../../../lib/pharmacy-receipt", () => ({
  loadReceiptSnapshot: async (tenantId: string, saleId: string, opts: unknown) => {
    if (m.failure) throw m.failure
    m.snapshots.push({ tenantId, saleId, opts })
    return saleId === "missing" ? null : { receiptNumber: "POS-0001" }
  },
  logReceiptEvent: async (event: Record<string, unknown>) => {
    m.events.push(event)
  },
}))

import { POST } from "./route"

const SALE_ID = "11111111-1111-4111-8111-111111111111"

const post = (saleId = SALE_ID) =>
  POST(
    new NextRequest(`http://localhost/api/mobile/pharmacy/sales/${saleId}/reprint`, {
      method: "POST",
      headers: { authorization: "Bearer token-1" },
    }),
    { params: Promise.resolve({ saleId }) },
  )

beforeEach(() => {
  m.auth.mockReset()
  m.auth.mockResolvedValue({ userId: "cashier-1", tenantId: "tenant-1", role: "pharmacy_cashier" })
  m.snapshots.length = 0
  m.events.length = 0
})

describe("POST /api/mobile/pharmacy/sales/[saleId]/reprint", () => {
  it("loads the sale-time snapshot marked as a reprint, scoped to the tenant", async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ receipt: { receiptNumber: "POS-0001" } })
    expect(m.snapshots).toEqual([
      { tenantId: "tenant-1", saleId: SALE_ID, opts: { isReprint: true } },
    ])
  })

  it("audits the reprint without creating a new sale or touching money", async () => {
    await post()
    expect(m.events).toEqual([
      {
        tenantId: "tenant-1",
        profileId: "cashier-1",
        action: "receipt.reprinted",
        saleId: SALE_ID,
        details: { receiptNumber: "POS-0001" },
      },
    ])
  })

  it("returns 404 for a sale outside the tenant and audits nothing", async () => {
    const res = await post("missing")
    expect(res.status).toBe(404)
    expect(m.events).toEqual([])
  })

  it("refuses an unauthenticated caller before reading the sale", async () => {
    m.auth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    )
    const res = await post()
    expect(res.status).toBe(401)
    expect(m.snapshots).toEqual([])
  })
})
