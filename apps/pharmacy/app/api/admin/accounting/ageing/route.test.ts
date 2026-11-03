import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({ ledger: [] as any[], currency: "UGX" }))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({ ok: true, tenantId: "tenant-1" })),
}))

vi.mock("@/lib/supabase/admin", () => {
  const chain = (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      lte: () => q,
      gt: () => q,
      order: () => q,
      limit: async () => ({
        data: table === "pharmacy_credit_ledger" ? m.ledger : [],
        error: null,
      }),
      maybeSingle: async () => ({ data: { currency: m.currency }, error: null }),
    }
    return q
  }
  return { supabaseAdmin: { from: (table: string) => chain(table) } }
})

async function ageing(query = "side=receivable&asOf=2026-11-01") {
  const { GET } = await import("./route")
  const res = await GET(
    new NextRequest(`http://localhost/api/admin/accounting/ageing?${query}`),
  )
  return { status: res.status, body: await res.json() }
}

const row = (over: Record<string, unknown>) => ({
  id: "l-1",
  customer_id: "c-1",
  transaction_id: null,
  amount: 0,
  type: "credit",
  due_date: null,
  created_at: "2026-10-01T09:00:00.000Z",
  customer: { name: "Acme Chemist" },
  ...over,
})

beforeEach(() => {
  m.ledger = []
  m.currency = "UGX"
})

describe("GET /api/admin/accounting/ageing — receivable settlement", () => {
  it("a refund on a credit sale reduces what the customer owes", async () => {
    m.ledger = [
      row({ id: "l-1", amount: 10000 }),
      row({ id: "l-2", amount: 4000, type: "refund", created_at: "2026-10-05T09:00:00.000Z" }),
    ]
    const { status, body } = await ageing()
    expect(status).toBe(200)
    expect(body.receivable.total).toBe(6000)
    expect(body.receivable.rows).toHaveLength(1)
    expect(body.receivable.rows[0].reference).toBe("CR-l-1")
  })

  it("a repayment still settles oldest-first", async () => {
    m.ledger = [
      row({ id: "l-1", amount: 10000 }),
      row({ id: "l-2", amount: 10000, created_at: "2026-10-02T09:00:00.000Z" }),
      row({ id: "l-3", amount: 12000, type: "repayment", created_at: "2026-10-06T09:00:00.000Z" }),
    ]
    const { body } = await ageing()
    expect(body.receivable.total).toBe(8000)
    expect(body.receivable.rows).toHaveLength(1)
    expect(body.receivable.rows[0].reference).toBe("CR-l-2")
  })

  it("a refund larger than the invoice leaves nothing owing, never a negative row", async () => {
    m.ledger = [
      row({ id: "l-1", amount: 5000 }),
      row({ id: "l-2", amount: 9000, type: "refund", created_at: "2026-10-07T09:00:00.000Z" }),
    ]
    const { body } = await ageing()
    expect(body.receivable.total).toBe(0)
    expect(body.receivable.rows).toEqual([])
  })
})
