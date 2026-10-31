import { describe, expect, it, vi } from "vitest"

// Every member of the tenant prints receipts, so reading settings is
// tenant-scoped. Writing them stays restricted to settings.manage.
const { asked, tenantChecked } = vi.hoisted(() => ({
  asked: [] as Array<string | string[]>,
  tenantChecked: { count: 0 },
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
    single: async () => ({ data: settingsRow, error: null }),
    upsert: () => q,
    insert: async () => ({ error: null }),
  }
  return { supabaseAdmin: { from: () => q } }
})

import { GET, POST } from "./route"

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
