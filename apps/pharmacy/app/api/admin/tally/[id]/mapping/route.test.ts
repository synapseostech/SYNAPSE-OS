import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { TALLY_SYSTEM_ACCOUNT_CODES } from "@synapse/db/tally-map"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))

import { GET, PUT } from "./route"

const AUTHORISED = {
  ok: true,
  tenantId: "tenant-1",
  session: { user: { id: "user-1" } },
}

const SYSTEM_KEY = Object.keys(TALLY_SYSTEM_ACCOUNT_CODES)[0]!

function sessionRow(status = "review", aiMapping: Record<string, unknown> = {}) {
  return { id: "session-1", status, ai_mapping: aiMapping }
}

function setup(row: unknown = sessionRow()) {
  m.db = fakeSupabase(
    (operation): FakeResult =>
      operation.action === "select" ? { data: row, error: null } : { data: null, error: null },
  )
}

const params = { params: Promise.resolve({ id: "session-1" }) }

const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/api/admin/tally/session-1/mapping", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    params,
  )

const get = () =>
  GET(new NextRequest("http://localhost/api/admin/tally/session-1/mapping"), params)

describe("PUT /api/admin/tally/[id]/mapping", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    setup()
  })

  it("refuses a session without inventory.write before touching the database", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await put({ conversionDate: "2026-01-01" })).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("rejects a cut-over date that is not YYYY-MM-DD", async () => {
    const res = await put({ conversionDate: "31/01/2026" })

    expect(res.status).toBe(400)
    expect(m.db.operations).toHaveLength(0)
  })

  it("rejects an override naming an unknown account type or system account", async () => {
    expect(
      (await put({ accountOverrides: { "Test Party A": { accountType: "revenue" } } })).status,
    ).toBe(400)
    expect(
      (await put({ accountOverrides: { "Test Party A": { systemKey: "not.a.real.account" } } }))
        .status,
    ).toBe(400)
    expect(
      (await put({ accountOverrides: { "Test Party A": { partyType: "patient" } } })).status,
    ).toBe(400)
    expect(m.db.operations).toHaveLength(0)
  })

  it("rejects an override with no fields and an unusable SKU", async () => {
    expect((await put({ accountOverrides: { "Test Party A": {} } })).status).toBe(400)
    expect((await put({ productSkuOverrides: { "Test Item A": "bad sku" } })).status).toBe(400)
    expect(m.db.operations).toHaveLength(0)
  })

  it("returns 404 for a session belonging to another tenant", async () => {
    setup(null)

    const res = await put({ conversionDate: "2026-01-01" })

    expect(res.status).toBe(404)
    expect(
      m.db.operations.filter((operation) => operation.action === "select")[0]?.filters,
    ).toEqual([
      ["id", "session-1"],
      ["tenant_id", "tenant-1"],
    ])
  })

  it("refuses to change the mapping once the import is being applied", async () => {
    setup(sessionRow("complete"))

    expect((await put({ conversionDate: "2026-01-01" })).status).toBe(409)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("merges overrides into the stored mapping and moves review to mapping", async () => {
    setup(sessionRow("review", { format: "xml", conversionDate: "2026-02-01" }))

    const res = await put({
      conversionDate: "2026-01-01",
      accountOverrides: { "  Test Party A  ": { partyType: "customer", systemKey: SYSTEM_KEY } },
      productSkuOverrides: { "test item a": "SKU-A" },
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      saved: true,
      conversionDate: "2026-01-01",
      accountOverrideCount: 1,
      productSkuOverrideCount: 1,
      needsPreview: true,
    })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      status: "mapping",
      ai_mapping: {
        format: "xml",
        conversionDate: "2026-01-01",
        accountOverrides: { "test party a": { partyType: "customer", systemKey: SYSTEM_KEY } },
        productSkuOverrides: { "test item a": "SKU-A" },
      },
    })
    expect(filtersOf(update!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("keeps an earlier status that already moved past review", async () => {
    setup(sessionRow("pending"))

    await put({ conversionDate: "2026-01-01" })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect((update?.payload as { status: string }).status).toBe("pending")
  })
})

describe("GET /api/admin/tally/[id]/mapping", () => {
  it("returns the saved overrides and the system account list", async () => {
    m.auth = AUTHORISED
    setup(
      sessionRow("mapping", {
        conversionDate: "2026-01-01",
        accountOverrides: { "test party a": { partyType: "customer" } },
      }),
    )

    const res = await get()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      status: "mapping",
      conversionDate: "2026-01-01",
      accountOverrides: { "test party a": { partyType: "customer" } },
      productSkuOverrides: {},
      systemAccountCodes: TALLY_SYSTEM_ACCOUNT_CODES,
    })
  })

  it("returns 404 when the session is not in the caller's tenant", async () => {
    setup(null)

    expect((await get()).status).toBe(404)
  })
})
