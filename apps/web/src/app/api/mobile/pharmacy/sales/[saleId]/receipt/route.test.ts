import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The receipt tells the phone whether the signed-in user may void the sale, so
 * a cashier (pos.sell, no pos.refund) is not offered a refund the server will
 * refuse. The refund route itself still enforces the same rule.
 */

const s = vi.hoisted(() => ({ role: "pharmacy_cashier" }))

vi.mock("../../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: async () => ({ userId: "staff-1", tenantId: "tenant-a", role: s.role }),
  isMobileAuth: () => true,
  isMobilePharmacyAdmin: (auth: { role: string }) =>
    ["pharmacy_admin", "pharmacy_ceo", "pharmacist"].includes(auth.role),
}))

vi.mock("../../../../../../../lib/pharmacy-receipt", () => ({
  loadReceiptSnapshot: async (tenantId: string, saleId: string) =>
    saleId === "sale-1" && tenantId === "tenant-a" ? { saleId, receiptNumber: "R-1" } : null,
}))

import { GET } from "./route"

const get = (saleId: string) =>
  GET(new Request(`http://x/api/mobile/pharmacy/sales/${saleId}/receipt`) as any, {
    params: Promise.resolve({ saleId }),
  })

beforeEach(() => {
  s.role = "pharmacy_cashier"
})

describe("mobile receipt refund flag", () => {
  it("shows a cashier the receipt without the refund action", async () => {
    const r = await get("sale-1")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ receipt: { saleId: "sale-1", receiptNumber: "R-1" }, canRefund: false })
  })

  it("offers the refund action to a store manager", async () => {
    s.role = "pharmacy_store_manager"
    expect((await (await get("sale-1")).json()).canRefund).toBe(true)
  })

  it("returns 404 for a sale outside the tenant", async () => {
    expect((await get("sale-2")).status).toBe(404)
  })
})
