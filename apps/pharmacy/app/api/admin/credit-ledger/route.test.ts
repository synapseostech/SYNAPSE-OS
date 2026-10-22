import { beforeEach, describe, expect, it, vi } from "vitest"

// The DB-side RPC (post_pharmacy_credit_entry) is simulated here: it locks the
// customer, computes the running balance, rejects overpayment and replays an
// already-used idempotency key. Real concurrency is proven in
// scripts/db-tests/pharmacy-concurrency.local.test.mjs against local Postgres.
const m = vi.hoisted(() => ({ balance: 0 as number, rows: [] as any[], calls: [] as any[] }))
vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({ ok: true, session: { user: { id: "u-1" } }, tenantId: "tenant-1" })),
}))
vi.mock("@/lib/tenant-ownership", () => ({ tenantOwnsRecord: vi.fn(async () => true) }))
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({ insert: async (v: any) => (m.calls.push({ fn: `insert:${table}`, args: v }), { error: null }) }),
    rpc: async (fn: string, args: any) => {
      m.calls.push({ fn, args })
      if (fn !== "post_pharmacy_credit_entry") return { data: null, error: { message: "unknown fn" } }
      const prior = args.p_idempotency_key && m.rows.find((r) => r.idempotency_key === args.p_idempotency_key)
      if (prior) return { data: { ...prior, replayed: true }, error: null }
      const next = args.p_type === "credit" ? m.balance + args.p_amount : m.balance - args.p_amount
      if (next < 0) return { data: null, error: { message: `OVERPAYMENT: balance ${m.balance}` } }
      m.balance = next
      const row = { id: `e-${m.rows.length + 1}`, balance_after: next, idempotency_key: args.p_idempotency_key }
      m.rows.push(row)
      return { data: { ...row, replayed: false }, error: null }
    },
  },
}))

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const { POST } = await import("./route")
  const res = await POST({ json: async () => body, headers: new Headers(headers) } as any)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  m.rows = []
  m.calls = []
  m.balance = 30000
})

describe("credit ledger repayments (atomic RPC)", () => {
  it("accepts a repayment up to the outstanding balance", async () => {
    const r = await post({ customerId: "c-1", type: "repayment", amount: 30000 }, { "Idempotency-Key": "rep-full" })
    expect(r.status).toBe(201)
    expect(m.rows[0].balance_after).toBe(0)
    expect(m.calls[0].args.p_tenant_id).toBe("tenant-1")
  })
  it("rejects an overpayment instead of silently clamping the balance to 0", async () => {
    const r = await post({ customerId: "c-1", type: "repayment", amount: 30001 }, { "Idempotency-Key": "rep-over" })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe("OVERPAYMENT")
    expect(r.body.balance).toBe(30000)
    expect(m.rows).toEqual([])
  })
  it("rejects a repayment when nothing is owed", async () => {
    m.balance = 0
    const r = await post({ customerId: "c-1", type: "repayment", amount: 1 }, { "Idempotency-Key": "rep-empty" })
    expect(r.status).toBe(400)
    expect(m.rows).toEqual([])
  })
  it("credit entries still add to the balance", async () => {
    const r = await post({ customerId: "c-1", type: "credit", amount: 500 })
    expect(r.status).toBe(201)
    expect(m.rows[0].balance_after).toBe(30500)
  })
  it("a retried repayment with the same Idempotency-Key posts exactly once", async () => {
    const a = await post({ customerId: "c-1", type: "repayment", amount: 1000 }, { "Idempotency-Key": "rep-1" })
    const b = await post({ customerId: "c-1", type: "repayment", amount: 1000 }, { "Idempotency-Key": "rep-1" })
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(m.rows).toHaveLength(1)
    expect(m.balance).toBe(29000)
  })
  it("never performs a read-then-write from the app (single RPC call)", async () => {
    await post({ customerId: "c-1", type: "credit", amount: 10 })
    expect(m.calls.map((c) => c.fn)).toEqual(["post_pharmacy_credit_entry", "insert:pharmacy_audit_logs"])
  })
})
