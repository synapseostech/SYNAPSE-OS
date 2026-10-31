import { beforeEach, describe, expect, it, vi } from "vitest"

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const P1 = "aaaaaaaa-0000-4000-8000-0000000000f1"
const P2 = "aaaaaaaa-0000-4000-8000-0000000000f2"
const m = vi.hoisted(() => ({ writes: [] as Array<{ table: string; op: string; values: any }> }))
const tables: Record<string, Array<Record<string, unknown>>> = {
  pharmacy_products: [
    { id: P1, tenant_id: A, sku: "SKU-1", name: "Amoxil", barcode: "6001234567890" },
    { id: P2, tenant_id: A, sku: "SKU-2", name: "Panadol", barcode: null },
    // Same barcode in ANOTHER pharmacy is fine.
    { id: "b-1", tenant_id: "tenant-b", sku: "SKU-B", name: "B", barcode: "7770000000001" },
  ],
}
vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({ ok: true, session: { user: { id: "u-a" }, storeId: null }, tenantId: A })),
}))
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const eqs: Record<string, unknown> = {}
      const neqs: Record<string, unknown> = {}
      let op: string | null = null
      const rows = () =>
        (tables[table] ?? []).filter(
          (r) => Object.entries(eqs).every(([k, v]) => r[k] === v) && Object.entries(neqs).every(([k, v]) => r[k] !== v),
        )
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => ((eqs[k] = v), q),
        ilike: () => q,
        neq: (k: string, v: unknown) => ((neqs[k] = v), q),
        limit: () => q,
        insert: (values: any) => ((op = "insert"), m.writes.push({ table, op, values }), q),
        update: (values: any) => ((op = "update"), m.writes.push({ table, op, values }), q),
        maybeSingle: async () => ({ data: op ? null : rows()[0] ?? null, error: null }),
        single: async () => ({ data: { id: P2 }, error: null }),
        then: (res: any) => Promise.resolve({ data: op ? null : rows(), error: null }).then(res),
      }
      return q
    },
  },
}))
const req = (body: unknown) => ({ json: async () => body }) as any
beforeEach(() => {
  m.writes = []
})

describe("barcode uniqueness per pharmacy", () => {
  it("POST with a barcode already used in this pharmacy -> 409, no insert", async () => {
    const { POST } = await import("./route")
    const res = await POST(req({ name: "X", sku: "NEW-1", price: 1, costPrice: 1, barcode: " 6001234567890 " }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("DUPLICATE_BARCODE")
    expect(m.writes).toEqual([])
  })
  it("POST with a barcode used only by another pharmacy is allowed", async () => {
    const { POST } = await import("./route")
    await POST(req({ name: "X", sku: "NEW-2", price: 1, costPrice: 1, barcode: "7770000000001" }))
    expect(m.writes.find((w) => w.table === "pharmacy_products")?.values.barcode).toBe("7770000000001")
  })
  it("POST stores a blank barcode as null (blanks never collide)", async () => {
    const { POST } = await import("./route")
    await POST(req({ name: "X", sku: "NEW-3", price: 1, costPrice: 1, barcode: "   " }))
    expect(m.writes.find((w) => w.table === "pharmacy_products")?.values.barcode).toBeNull()
  })
  it("PATCH moving another product's barcode onto P2 -> 409", async () => {
    const { PATCH } = await import("./route")
    const res = await PATCH(req({ id: P2, name: "Panadol", sku: "SKU-2", price: 1, costPrice: 1, barcode: "6001234567890" }))
    expect(res.status).toBe(409)
    expect(m.writes).toEqual([])
  })
  it("PATCH keeping a product's own barcode is allowed", async () => {
    const { PATCH } = await import("./route")
    const res = await PATCH(req({ id: P1, name: "Amoxil", sku: "SKU-1", price: 1, costPrice: 1, barcode: "6001234567890" }))
    expect(res.status).not.toBe(409)
  })
})
