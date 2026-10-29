import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { fakeSupabase, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyTenant: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))

import { PUT } from "./route"

const ADMIN = { ok: true, tenantId: "tenant-1", session: { user: { id: "user-1" } } }
const params = { params: Promise.resolve({ id: "transaction-1" }) }

const MIRROR_NOTE = "Imported from Tally (Test Pharmacy Ltd) — read-only"

function setup(transaction: unknown) {
  m.db = fakeSupabase((operation): FakeResult => {
    if (operation.table === "pharmacy_pos_sales") return { data: null, error: null }
    if (operation.table === "pharmacy_transactions") return { data: transaction, error: null }
    return { data: [], error: null }
  })
}

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/admin/transactions/transaction-1/edit", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  )
}

function transaction(overrides: Record<string, unknown> = {}) {
  return { id: "transaction-1", notes: null, items: [], discount: 0, ...overrides }
}

const EDIT = {
  items: [],
  paymentMethod: "CASH",
  reason: "Correcting a mistyped price",
}

describe("PUT /api/admin/transactions/[id]/edit", () => {
  beforeEach(() => {
    m.auth = ADMIN
    setup(transaction({ notes: MIRROR_NOTE }))
  })

  it("refuses to edit a Tally mirror sale", async () => {
    const res = await put(EDIT)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_MIRROR_READ_ONLY" })
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("still edits a sale entered in the portal", async () => {
    setup(transaction())

    const res = await put({ ...EDIT, items: [{ id: "item-1", quantity: 1, unitPrice: 40 }] })

    expect(res.status).toBe(200)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(true)
  })
})
