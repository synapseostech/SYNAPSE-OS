import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

const state = {
  rows: {} as Record<string, unknown[]>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  customerExists: true,
}

const rpc = vi.hoisted(() => vi.fn())

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.eq = self
      builder.order = self
      builder.limit = () => Promise.resolve({ data: state.rows[table] ?? [], error: null })
      builder.maybeSingle = () =>
        Promise.resolve({
          data: table === "pharmacy_customers" && state.customerExists ? { id: "c1" } : null,
          error: null,
        })
      builder.insert = (row: Record<string, unknown>) => {
        state.inserts.push({ table, row })
        return builder
      }
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: state.rows[table] ?? [], error: null }).then(resolve)
      return builder
    },
  },
}))

import { GET, POST } from "./route"

function auth(role = "pharmacist", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function post(body: unknown) {
  return new Request("https://app.test/api/mobile/pharmacy/credit-ledger", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

describe("mobile pharmacy credit ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.rows = {}
    state.inserts = []
    state.customerExists = true
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) && typeof value === "object" && !(value instanceof NextResponse) && "tenantId" in (value as object),
    )
  })

  it("denies the ledger without the credit permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(new Request("https://app.test/api/mobile/pharmacy/credit-ledger") as never)

    expect(res.status).toBe(403)
  })

  it("summarises outstanding and overdue balances from the newest row per customer", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation((_a: unknown, cap: string) => cap === "customers.credit")
    state.rows.pharmacy_credit_ledger = [
      {
        id: "e1",
        customer_id: "c1",
        customer: { name: "Alice" },
        amount: 5000,
        type: "credit",
        balance_after: 5000,
        due_date: "2020-01-01",
        notes: null,
        created_at: "2026-10-20T10:00:00.000Z",
      },
      {
        id: "e2",
        customer_id: "c1",
        customer: { name: "Alice" },
        amount: 1000,
        type: "repayment",
        balance_after: 4000,
        due_date: null,
        notes: null,
        created_at: "2026-10-21T10:00:00.000Z",
      },
      {
        id: "e3",
        customer_id: "c2",
        customer: { name: "Bob" },
        amount: 2000,
        type: "repayment",
        balance_after: 0,
        due_date: null,
        notes: null,
        created_at: "2026-10-22T10:00:00.000Z",
      },
    ]

    const res = await GET(new Request("https://app.test/api/mobile/pharmacy/credit-ledger") as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary).toEqual({
      totalOutstanding: 5000,
      overdueOutstanding: 5000,
      creditCustomers: 1,
      overdueCustomers: 1,
    })
    expect(body.entries[0]).toMatchObject({ id: "e1", customerName: "Alice", balanceAfter: 5000 })
  })

  it("requires an idempotency key for repayments", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(true)

    const res = await POST(post({ customerId: "c1", type: "repayment", amount: 1000 }))

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("rejects amounts with more than two decimals", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(true)

    const res = await POST(post({ customerId: "c1", type: "credit", amount: 10.005 }))

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("maps an overpayment rejection from the database routine", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(true)
    rpc.mockResolvedValue({ data: null, error: { message: "OVERPAYMENT balance 500.00" } })

    const res = await POST(
      post({ customerId: "c1", type: "repayment", amount: 900, idempotencyKey: "key-1" }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "OVERPAYMENT", balance: 500 })
  })

  it("posts through the shared routine and audits a new credit entry", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(true)
    rpc.mockResolvedValue({ data: { id: "l1", balance_after: 5000, replayed: false }, error: null })

    const res = await POST(post({ customerId: "c1", type: "credit", amount: 5000 }))

    expect(res.status).toBe(201)
    expect(rpc).toHaveBeenCalledWith(
      "post_pharmacy_credit_entry",
      expect.objectContaining({
        p_tenant_id: "tenant-a",
        p_customer_id: "c1",
        p_type: "credit",
        p_amount: 5000,
      }),
    )
    const audit = state.inserts.find(({ table }) => table === "pharmacy_audit_logs")
    expect(audit?.row).toMatchObject({ tenant_id: "tenant-a", action: "CREATE_CREDIT_LEDGER_ENTRY" })
  })

  it("does not double-audit a replayed entry", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(true)
    rpc.mockResolvedValue({ data: { id: "l1", balance_after: 5000, replayed: true }, error: null })

    const res = await POST(
      post({ customerId: "c1", type: "repayment", amount: 5000, idempotencyKey: "key-1" }),
    )

    expect(res.status).toBe(200)
    expect(state.inserts).toHaveLength(0)
  })
})
