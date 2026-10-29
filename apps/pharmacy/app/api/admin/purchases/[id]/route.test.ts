import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

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

import { PATCH } from "./route"

const ADMIN = {
  ok: true,
  tenantId: "tenant-1",
  session: { user: { id: "user-1" } },
}

const params = { params: Promise.resolve({ id: "purchase-1" }) }

function setup(purchase: unknown) {
  m.db = fakeSupabase(
    (operation): FakeResult =>
      operation.action === "select" ? { data: purchase, error: null } : { data: null, error: null },
  )
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/admin/purchases/purchase-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  )
}

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    id: "purchase-1",
    status: "RECEIVED",
    total: 100,
    amount_paid: 0,
    payment_status: "UNPAID",
    notes: null,
    ...overrides,
  }
}

describe("PATCH /api/admin/purchases/[id]", () => {
  beforeEach(() => {
    m.auth = ADMIN
    setup(purchase())
  })

  it("refuses a payment against a Tally mirror purchase", async () => {
    setup(purchase({ status: "DRAFT", notes: "Imported from Tally (Test Pharmacy Ltd) — read-only" }))

    const res = await patch({ amountPaid: 50 })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_MIRROR_READ_ONLY" })
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses to cancel a Tally mirror purchase", async () => {
    setup(purchase({ status: "DRAFT", notes: "Imported from Tally (Test Pharmacy Ltd) — read-only" }))

    const res = await patch({ status: "CANCELLED" })

    expect(res.status).toBe(409)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("still records a payment against a purchase entered in the portal", async () => {
    const res = await patch({ amountPaid: 50 })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, amountPaid: 50, balance: 50 })
    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({ amount_paid: 50, balance: 50 })
  })

  it("returns 403 when the session lacks purchasing.manage", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await patch({ amountPaid: 50 })).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })
})
