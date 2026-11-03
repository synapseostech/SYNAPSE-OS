import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Mobile settings must not clobber fields the caller never sent.
 *
 * The route used to write `vat_enabled: Boolean(d.vatEnabled)` and
 * `vat_rate: d.vatRate ?? 18` on every save, so a screen that never showed VAT
 * silently switched it off and reset the rate. Tax values are percentages
 * (18 means 18%) and an out-of-range one is refused instead of reaching the
 * numeric column and surfacing as a 500.
 */

const s = vi.hoisted(() => ({
  admin: true,
  settingsRow: {} as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock("@synapse/db/admin", () => {
  const from = () => {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: s.settingsRow, error: null }),
      upsert: async (payload: Record<string, unknown>) => {
        s.upserts.push(payload)
        return { error: null }
      },
      update: (payload: Record<string, unknown>) => {
        s.updates.push(payload)
        return Promise.resolve({ error: null })
      },
      insert: async () => ({ error: null }),
    }
    return q
  }
  return { supabaseAdmin: { from } }
})

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: async () => ({
    userId: "user-a",
    tenantId: "tenant-a",
    role: "pharmacy_admin",
  }),
  isMobileAuth: () => true,
  isMobilePharmacyAdmin: () => s.admin,
}))

import { POST } from "./route"

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://api.test/mobile/pharmacy/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as any,
  )
}

describe("mobile pharmacy settings", () => {
  beforeEach(() => {
    s.admin = true
    s.settingsRow = null
    s.upserts.length = 0
    s.updates.length = 0
  })

  it("stays admin-only", async () => {
    s.admin = false
    const res = await post({ pharmacyName: "Test Pharmacy" })
    expect(res.status).toBe(403)
    expect(s.upserts).toHaveLength(0)
  })

  it("does not disable VAT or reset its rate when the payload omits them", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy" })
    expect(res.status).toBe(200)
    expect(s.updates[0]).not.toHaveProperty("vat_enabled")
    expect(s.updates[0]).not.toHaveProperty("vat_rate")
  })

  it("stores an explicit VAT configuration", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", vatEnabled: true, vatRate: 18 })
    expect(res.status).toBe(200)
    expect(s.updates[0]).toMatchObject({ vat_enabled: true, vat_rate: 18 })
  })

  it("stores tax_rate as a percentage: 18 means 18%, not 0.18", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", taxRate: 18 })
    expect(res.status).toBe(200)
    expect(s.upserts[0]).toMatchObject({ tax_rate: 18 })
  })

  it("does not write tax_rate when the payload omits it", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy" })
    expect(res.status).toBe(200)
    expect(s.upserts[0]).not.toHaveProperty("tax_rate")
  })

  it("refuses a rate outside 0–100 before touching the database", async () => {
    for (const body of [{ taxRate: 150 }, { vatRate: -1 }, { taxRate: "abc" }]) {
      s.upserts.length = 0
      const res = await post({ pharmacyName: "Test Pharmacy", ...body })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ code: "INVALID_TAX_RATE" })
      expect(s.upserts).toHaveLength(0)
    }
  })
})
