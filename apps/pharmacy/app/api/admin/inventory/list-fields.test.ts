import { describe, expect, it, vi } from "vitest"

// The inventory list drives the portal's category column and its search box.
// A row without `category` made `product.category.toLowerCase()` throw the
// moment a cashier typed in the search field, so the field is pinned here.
const A = "aaaaaaaa-0000-4000-8000-000000000001"
const rows = [
  { id: "p-1", tenant_id: A, name: "Amoxil", sku: "AMX-1", category: "Antibiotics", price: 500, quantity: 5, is_active: true },
  { id: "p-2", tenant_id: A, name: "Panadol", sku: "PAN-1", category: null, price: 200, quantity: 3, is_active: true },
]

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "u-a" }, storeId: null },
    tenantId: A,
  })),
}))

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        then: (res: any) => Promise.resolve({ data: rows, error: null }).then(res),
      }
      return q
    },
  },
}))

describe("GET /api/admin/inventory", () => {
  it("returns a category for every product so list search cannot crash", async () => {
    const { GET } = await import("./route")
    const res = await GET({} as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ category: unknown }>
    expect(body.map((p) => p.category)).toEqual(["Antibiotics", "General"])
  })
})
