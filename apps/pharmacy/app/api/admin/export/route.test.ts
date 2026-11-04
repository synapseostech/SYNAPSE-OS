import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, filtersOf, type FakeOperation } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyAdmin: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))

import { GET } from "./route"

const AUTHORISED = {
  ok: true,
  tenantId: "tenant-1",
  session: {
    user: { id: "user-1" },
    role: "pharmacy_admin",
    pharmacyRole: "pharmacy_admin",
    permissions: [],
    isAdmin: true,
  },
}

type Tables = Record<string, unknown[]>

/** A fake database whose paging respects the `.range()` window. */
function setUp(tables: Tables, counts: Record<string, number> = {}) {
  const db = fakeSupabase((operation) => {
    const rows = tables[operation.table] ?? []
    return {
      data: operation.window ? rows.slice(operation.window.from, operation.window.to + 1) : rows,
      error: null,
      count: counts[operation.table] ?? rows.length,
    }
  })
  m.db = db
  return db.operations
}

/** Today as the pharmacy reads it, matching the filename the route stamps. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function request(query: string) {
  return new NextRequest(`http://localhost/api/admin/export?${query}`)
}

const CUSTOMERS: Tables = {
  pharmacy_customers: [
    {
      id: "c1",
      name: "=1+1",
      phone: "+256700000000",
      email: null,
      address: null,
      is_active: true,
      created_at: "2026-01-05T10:00:00Z",
    },
  ],
}

const SALES: Tables = {
  pharmacy_pos_sales: [
    {
      id: "s1",
      receipt_number: "R-1",
      status: "completed",
      subtotal: 100,
      discount_total: 0,
      tax_amount: 0,
      total_amount: 100,
      payment_method: "cash",
      cashier_id: null,
      created_at: "2026-01-05T10:00:00Z",
    },
  ],
  pharmacy_transactions: [],
}

beforeEach(() => {
  m.auth = AUTHORISED
  setUp({})
})

describe("permission", () => {
  it("refuses a non-admin", async () => {
    m.auth = {
      ok: false,
      response: NextResponse.json({ error: "Admin only" }, { status: 403 }),
    }

    const response = await GET(request("dataset=customers&format=csv"))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Admin only" })
    expect(m.db.operations).toHaveLength(0)
  })
})

describe("validation", () => {
  it("refuses an unknown export", async () => {
    const response = await GET(request("dataset=everything&format=csv"))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/Unknown export/)
  })

  it("refuses an unknown format", async () => {
    const response = await GET(request("dataset=customers&format=pdf"))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/csv or xlsx/)
  })

  it("needs both dates for a dated export", async () => {
    const response = await GET(request("dataset=sales&format=csv"))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/start and end date/)
    expect(m.db.operations).toHaveLength(0)
  })

  it("refuses an end date before the start", async () => {
    const response = await GET(
      request("dataset=sales&format=csv&from=2026-02-01&to=2026-01-01"),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/before the start/)
  })

  it("refuses a day that does not exist", async () => {
    const response = await GET(
      request("dataset=sales&format=csv&from=2026-02-30&to=2026-03-01"),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/start and end date/)
  })

  it("refuses a range above the row cap instead of truncating it", async () => {
    setUp(CUSTOMERS, { pharmacy_customers: 100_001 })

    const response = await GET(request("dataset=customers&format=csv"))

    expect(response.status).toBe(413)
    expect((await response.json()).error).toMatch(/Narrow the date range/)
  })
})

describe("csv", () => {
  it("writes a header, the rows, and neutralises a formula", async () => {
    setUp(CUSTOMERS)

    const response = await GET(request("dataset=customers&format=csv"))
    const bytes = new Uint8Array(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8")
    const today = kampalaToday()
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="synapse-customers-${today}.csv"`,
    )
    // The byte-order mark is what makes Excel read the file as UTF-8.
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3))
    expect(body).toBe(
      'Name,Phone,Email,Address,Active,Created\r\n' +
        '"\'=1+1",+256700000000,,,Yes,2026-01-05 13:00\r\n',
    )
  })

  it("scopes every dated query to the tenant and the Kampala day", async () => {
    const operations = setUp(SALES)

    await GET(request("dataset=sales&format=csv&from=2026-01-01&to=2026-01-31"))

    const scoped = operations.filter((operation) =>
      ["pharmacy_pos_sales", "pharmacy_transactions"].includes(operation.table),
    )
    expect(scoped.length).toBeGreaterThan(0)
    for (const operation of scoped) {
      expect(filtersOf(operation).tenant_id).toBe("tenant-1")
      expect(
        operation.bounds.filter((bound) => bound.column === "created_at").map((bound) => bound.value),
      ).toContain("2026-01-01T00:00:00+03:00")
    }
  })

  it("exports a snapshot without a date range", async () => {
    setUp(CUSTOMERS)

    const response = await GET(request("dataset=customers&format=csv"))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Name,Phone,Email")
  })
})

describe("xlsx", () => {
  it("writes a workbook Excel can open", async () => {
    setUp(CUSTOMERS)

    const response = await GET(request("dataset=customers&format=xlsx"))
    const bytes = new Uint8Array(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml")
    const today = kampalaToday()
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="synapse-customers-${today}.xlsx"`,
    )
    // A zip container: "PK\x03\x04".
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(bytes.length).toBeGreaterThan(1000)
  })
})

describe("audit", () => {
  it("records the export against the tenant and the dataset", async () => {
    const operations = setUp(CUSTOMERS)

    await GET(request("dataset=customers&format=csv"))

    const insert = operations.find(
      (operation) => operation.table === "pharmacy_audit_logs" && operation.action === "insert",
    )
    expect(insert?.payload).toMatchObject({
      tenant_id: "tenant-1",
      profile_id: "user-1",
      action: "EXPORT_DATA",
      entity: "EXPORT",
      entity_id: "customers",
      details: { dataset: "customers", from: null, to: null, format: "csv", records: 1 },
    })
  })

  it("names the range it exported", async () => {
    const operations = setUp(SALES)

    await GET(request("dataset=sales&format=csv&from=2026-01-01&to=2026-01-31"))

    const insert = operations.find((operation) => operation.table === "pharmacy_audit_logs")
    expect((insert?.payload as { details: unknown }).details).toMatchObject({
      dataset: "sales",
      from: "2026-01-01",
      to: "2026-01-31",
      format: "csv",
      records: 1,
    })
  })
})
