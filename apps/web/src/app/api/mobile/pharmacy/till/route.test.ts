import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The phone till must let every selling role open, top up and close its own
 * till, and refuse a role that does not take money. The capability table is the
 * real one from @synapse/auth, so a role losing shift.open_close fails here.
 */

const s = vi.hoisted(() => ({
  role: "pharmacy_cashier",
  calls: [] as { fn: string; args: Record<string, unknown> }[],
}))

vi.mock("../../../../../lib/mobile-pharmacy-auth", async () => {
  const { roleHasCapability } = await import("@synapse/auth/pharmacy-capabilities")
  return {
    requireMobilePharmacyAuth: async () => ({ userId: "staff-1", tenantId: "tenant-a", role: s.role }),
    isMobileAuth: () => true,
    mobileHasPharmacyCapability: (auth: { role: string }, capability: any) =>
      roleHasCapability(auth.role, capability),
  }
})

vi.mock("@synapse/db/errors", () => ({ httpStatusForPharmacyError: () => 409 }))

vi.mock("@synapse/db/till-service", () => {
  const session = { id: "till-1", status: "open" }
  const record = (fn: string) => async (args: Record<string, unknown>) => {
    s.calls.push({ fn, args })
    return { ok: true, session }
  }
  return {
    getOpenTill: async (args: Record<string, unknown>) => (s.calls.push({ fn: "getOpenTill", args }), session),
    presentTill: (row: unknown) => row,
    openTill: record("openTill"),
    closeTill: record("closeTill"),
    recordCashMovement: record("recordCashMovement"),
  }
})

import { GET, POST } from "./route"

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/mobile/pharmacy/till", {
      method: "POST",
      body: JSON.stringify(body),
    }) as any,
  )
const get = () => GET(new Request("http://x/api/mobile/pharmacy/till") as any)

beforeEach(() => {
  s.role = "pharmacy_cashier"
  s.calls = []
})

describe("mobile till for staff roles", () => {
  for (const role of ["pharmacy_cashier", "pharmacy_staff", "pharmacist", "pharmacy_store_manager"]) {
    it(`lets a ${role} open and close their own till`, async () => {
      s.role = role
      expect((await get()).status).toBe(200)

      const opened = await post({ action: "open", openingFloat: 5000 })
      expect(opened.status).toBe(200)
      const closed = await post({ action: "close", sessionId: "till-1", countedCash: 5000 })
      expect(closed.status).toBe(200)

      const open = s.calls.find((c) => c.fn === "openTill")!
      expect(open.args).toMatchObject({ tenantId: "tenant-a", cashierId: "staff-1", openingFloat: 5000 })
      // Always the caller's own till: the closer is the cashier.
      const close = s.calls.find((c) => c.fn === "closeTill")!
      expect(close.args).toMatchObject({ cashierId: "staff-1", closerId: "staff-1" })
    })
  }

  it("ignores a cashierId in the body, so a cashier cannot close someone else's till", async () => {
    await post({ action: "close", sessionId: "till-9", countedCash: 0, cashierId: "other" })
    expect(s.calls.find((c) => c.fn === "closeTill")!.args.cashierId).toBe("staff-1")
  })

  it("refuses a pharmacy role that does not take money", async () => {
    s.role = "inventory_officer"
    expect((await get()).status).toBe(403)
    const r = await post({ action: "open", openingFloat: 0 })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: "shift.open_close capability required", code: "FORBIDDEN" })
    expect(s.calls).toHaveLength(0)
  })
})
