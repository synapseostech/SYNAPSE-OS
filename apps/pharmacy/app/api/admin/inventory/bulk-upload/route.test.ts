import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  allow: true,
  permission: "" as string,
  inserts: [] as Array<{ table: string; values: any }>,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async (cap: string) => {
    m.permission = cap
    if (!m.allow) {
      const { NextResponse } = await import("next/server")
      return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    }
    return { ok: true, session: { user: { id: "u-1" } }, tenantId: "tenant-1" }
  }),
}))
vi.mock("@synapse/db/inventory-rpc", () => ({ receivePharmacyStock: vi.fn(async () => ({ error: null })) }))
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let insert: any = null
      const q: any = {
        select: () => q,
        eq: () => q,
        range: () => q,
        insert: (v: any) => ((insert = v), m.inserts.push({ table, values: v }), q),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: insert ? { id: `id-${m.inserts.length}` } : null, error: null }),
        then: (res: any) => Promise.resolve({ data: [], error: null }).then(res),
      }
      return q
    },
  },
}))

async function upload(name: string, type: string, body: string | Uint8Array) {
  const { POST } = await import("./route")
  const fd = new FormData()
  fd.append("file", new File([body], name, { type }))
  const res = await POST({ formData: async () => fd } as any)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  m.allow = true
  m.inserts = []
})

describe("POST /api/admin/inventory/bulk-upload hardening", () => {
  it("requires the inventory.write capability, not just a tenant", async () => {
    m.allow = false
    const r = await upload("s.csv", "text/csv", "name,price\nA,100\n")
    expect(r.status).toBe(403)
    expect(m.permission).toBe("inventory.write")
    expect(m.inserts).toEqual([])
  })

  it("rejects a wrong MIME with 415 and writes nothing", async () => {
    const r = await upload("s.csv", "image/png", "name,price\nA,100\n")
    expect(r.status).toBe(415)
    expect(m.inserts).toEqual([])
  })

  it("rejects > 10k rows with 413 and writes nothing", async () => {
    const r = await upload("s.csv", "text/csv", "name,price\n" + "A,1\n".repeat(10_001))
    expect(r.status).toBe(413)
    expect(m.inserts).toEqual([])
  })

  it("stores formula-looking cells neutralised", async () => {
    const r = await upload("s.csv", "text/csv", 'name,price,sku\n"=HYPERLINK(""http://evil"",""x"")",100,@SKU1\n')
    expect(r.status).toBe(200)
    const product = m.inserts.find((i) => i.table === "pharmacy_products")!.values
    expect(product.name).toBe(`'=HYPERLINK("http://evil","x")`)
    expect(product.sku).toBe("'@SKU1")
  })
})
