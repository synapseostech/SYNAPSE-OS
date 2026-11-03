import { beforeEach, describe, expect, it, vi } from "vitest"

// Every member of the tenant prints receipts, so reading settings is
// tenant-scoped. Writing them stays restricted to settings.manage.
const { asked, tenantChecked, upserts, upsertError } = vi.hoisted(() => ({
  asked: [] as Array<string | string[]>,
  tenantChecked: { count: 0 },
  upserts: [] as Array<Record<string, unknown>>,
  upsertError: { value: null as null | { message: string } },
}))
vi.mock("@/lib/api-auth", () => ({
  requirePharmacyTenant: async () => {
    tenantChecked.count += 1
    return {
      ok: true as const,
      tenantId: "tenant-A",
      session: { user: { id: "user-A" }, userId: "user-A", tenantId: "tenant-A" },
    }
  },
  requirePharmacyPermission: async (permission: string | string[]) => {
    asked.push(permission)
    return {
      ok: true as const,
      tenantId: "tenant-A",
      session: { user: { id: "user-A" }, userId: "user-A", tenantId: "tenant-A" },
    }
  },
}))

const settingsRow = {
  id: "settings-A",
  tenant_id: "tenant-A",
  pharmacy_name: "Test Pharmacy",
  auto_print_receipt: true,
}
vi.mock("@/lib/supabase/admin", () => {
  const q: any = {
    select: () => q,
    eq: () => q,
    single: async () => ({ data: upsertError.value ? null : settingsRow, error: upsertError.value }),
    upsert: (payload: Record<string, unknown>) => (upserts.push(payload), q),
    insert: async () => ({ error: null }),
  }
  return { supabaseAdmin: { from: () => q } }
})

import { GET, POST } from "./route"

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://pharm.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as any,
  )
}

describe("settings route guards", () => {
  it("GET needs only a tenant session so any printer can read branding", async () => {
    const res = await GET(new Request("http://pharm.test/api") as any)
    expect(res.status).toBe(200)
    expect(tenantChecked.count).toBe(1)
    expect(asked).toEqual([])
  })

  it("POST stays restricted to settings.manage", async () => {
    const req = new Request("http://pharm.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pharmacyName: "Test Pharmacy" }),
    }) as any
    await POST(req)
    expect(asked.at(-1)).toBe("settings.manage")
  })
})

describe("settings tax configuration", () => {
  beforeEach(() => {
    upserts.length = 0
    upsertError.value = null
  })

  it("stores tax_rate as a percentage: 18 means 18%, not 0.18", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", taxRate: 18 })
    expect(res.status).toBe(200)
    expect(upserts[0]).toMatchObject({ tax_rate: 18 })
  })

  it("reports an un-migrated numeric(5,4) column as a tax-rate problem, not a 500", async () => {
    // A database that has not had 20261102100000 applied still cannot hold 18.
    // The operator needs to be told which column, not shown an internal error.
    upsertError.value = { message: 'numeric field overflow' }
    const res = await post({ pharmacyName: "Test Pharmacy", taxRate: 18 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: "TAX_RATE_COLUMN_TOO_SMALL", field: "taxRate" })
  })

  it("refuses a rate above the percentage bound", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", taxRate: 101 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: "INVALID_TAX_RATE", field: "taxRate" })
    expect(upserts).toHaveLength(0)
  })

  it("refuses a negative or non-numeric taxRate", async () => {
    for (const taxRate of [-1, "abc"]) {
      upserts.length = 0
      const res = await post({ pharmacyName: "Test Pharmacy", taxRate })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ code: "INVALID_TAX_RATE" })
      expect(upserts).toHaveLength(0)
    }
  })

  it("stores a VAT configuration the sale routes can use", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", taxRate: 0, vatEnabled: true, vatRate: 18 })
    expect(res.status).toBe(200)
    expect(upserts[0]).toMatchObject({ vat_enabled: true, vat_rate: 18 })
  })

  it("leaves VAT untouched when the payload does not mention it", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", taxRate: 5 })
    expect(res.status).toBe(200)
    expect(upserts[0]).not.toHaveProperty("vat_enabled")
    expect(upserts[0]).not.toHaveProperty("vat_rate")
  })

  it("refuses a VAT rate outside 0–100", async () => {
    const res = await post({ pharmacyName: "Test Pharmacy", vatEnabled: true, vatRate: 150 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: "INVALID_VAT_RATE" })
    expect(upserts).toHaveLength(0)
  })
})
