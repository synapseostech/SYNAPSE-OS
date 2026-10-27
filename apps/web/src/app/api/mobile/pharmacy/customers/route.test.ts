import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, registerPersonForFacility } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  registerPersonForFacility: vi.fn(),
}))

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
}))

vi.mock("@synapse/db/identity-persist", () => ({
  registerPersonForFacility: (...args: unknown[]) => registerPersonForFacility(...args),
}))

const state = {
  rows: {} as Record<string, unknown[]>,
  created: null as Record<string, unknown> | null,
  duplicate: false,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  filters: [] as Array<{ table: string; args: unknown[] }>,
  personFails: false,
}

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.order = self
      builder.not = self
      builder.limit = () => Promise.resolve({ data: state.rows[table] ?? [], error: null })
      builder.eq = (...args: unknown[]) => {
        state.filters.push({ table, args })
        return builder
      }
      builder.maybeSingle = () =>
        Promise.resolve({
          data: table === "pharmacy_customers" && state.duplicate ? { id: "existing" } : null,
          error: null,
        })
      builder.single = () => Promise.resolve({ data: state.created, error: null })
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
  return new Request("https://app.test/api/mobile/pharmacy/customers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

describe("mobile pharmacy customers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.rows = {}
    state.created = null
    state.duplicate = false
    state.inserts = []
    state.filters = []
    state.personFails = false
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) && typeof value === "object" && !(value instanceof NextResponse) && "tenantId" in (value as object),
    )
    registerPersonForFacility.mockImplementation(async () => {
      if (state.personFails) throw new Error("identity down")
      return { id: "person-1", synapseId: "SYN-1" }
    })
  })

  it("lists only the authenticated tenant customers", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacist", "tenant-a"))
    state.rows.pharmacy_customers = [{ id: "c1", name: "Alice", tenant_id: "tenant-a" }]

    const res = await GET(new Request("https://app.test/api/mobile/pharmacy/customers") as never)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.customers[0]).toMatchObject({ id: "c1", name: "Alice", counts: { orders: 0, transactions: 0 } })
    expect(
      state.filters.some(
        ({ table, args }) => table === "pharmacy_customers" && args[0] === "tenant_id" && args[1] === "tenant-a",
      ),
    ).toBe(true)
    expect(state.filters.some(({ args }) => args[1] === "tenant-b")).toBe(false)
  })

  it("rejects unauthenticated access", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    isMobileAuth.mockReturnValue(false)

    const res = await GET(new Request("https://app.test/api/mobile/pharmacy/customers") as never)

    expect(res.status).toBe(401)
  })

  it("requires a name and a way to contact the customer", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const missingName = await POST(post({ phone: "0700000000" }))
    expect(missingName.status).toBe(400)

    const missingContact = await POST(post({ name: "Alice" }))
    expect(missingContact.status).toBe(400)
    expect(state.inserts).toHaveLength(0)
  })

  it("rejects a duplicate email in the same tenant", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.duplicate = true

    const res = await POST(post({ name: "Alice", email: "alice@example.com" }))

    expect(res.status).toBe(400)
    expect(state.inserts).toHaveLength(0)
  })

  it("creates the customer, links the Synapse identity and audits it", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.created = { id: "c-new", name: "Alice", email: "alice@example.com", phone: null }

    const res = await POST(post({ name: "Alice", email: "alice@example.com" }))

    expect(res.status).toBe(201)
    expect(registerPersonForFacility).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", sourceSystem: "synapse-pharm-mobile" }),
    )
    const customerInsert = state.inserts.find(({ table }) => table === "pharmacy_customers")
    expect(customerInsert?.row).toMatchObject({ tenant_id: "tenant-a", person_id: "person-1" })
    const auditInsert = state.inserts.find(({ table }) => table === "pharmacy_audit_logs")
    expect(auditInsert?.row).toMatchObject({ tenant_id: "tenant-a", action: "CREATE_CUSTOMER" })
  })

  it("still creates the customer when identity registration fails", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.personFails = true
    state.created = { id: "c-new", name: "Alice", phone: "0700000000" }

    const res = await POST(post({ name: "Alice", phone: "0700000000" }))

    expect(res.status).toBe(201)
    const customerInsert = state.inserts.find(({ table }) => table === "pharmacy_customers")
    expect(customerInsert?.row).not.toHaveProperty("person_id")
  })
})
