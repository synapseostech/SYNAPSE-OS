import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import type { TallyApplyProgress } from "@/lib/tally/apply"
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

import { DELETE, GET } from "./route"

const AUTHORISED = {
  ok: true,
  tenantId: "tenant-1",
  session: {
    user: { id: "user-1" },
    role: "pharmacy_admin",
    pharmacyRole: "pharmacy_admin",
    permissions: [],
    isAdmin: false,
  },
}

function progress(failures = 0): TallyApplyProgress {
  return {
    stage: "journals",
    offset: 120,
    counts: {
      accounts: 8,
      parties: 2,
      products: 2,
      openingJournal: 1,
      openingStock: 1,
      journals: 4,
      sales: 0,
      purchases: 0,
    },
    failures: Array.from({ length: failures }, (_, index) => ({
      stage: "journals" as const,
      key: `voucher-${index}`,
      code: "TALLY_VOUCHER_UNBALANCED",
      message: "Skipped an unbalanced voucher.",
    })),
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function sessionRow(status = "importing", mapping: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status,
    source_system: "Tally",
    file_name: "tally.xml",
    total_rows: 6,
    flagged_rows: 2,
    ai_mapping: mapping,
    ai_summary: null,
    error_message: null,
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
  }
}

function setup(session: unknown, cutoverOwner: string | null = null) {
  m.db = fakeSupabase(
    (operation): FakeResult => {
      if (operation.table === "pharmacy_tally_cutover_locks") {
        return {
          data: cutoverOwner ? { session_id: cutoverOwner } : null,
          error: null,
        }
      }
      const isCutoverQuery = operation.filters.some(
        ([column, value]) => column === "source_system" && value === "Tally",
      )
      if (isCutoverQuery) return { data: null, error: null }
      return operation.action === "select"
        ? { data: session, error: null }
        : { data: null, error: null }
    },
  )
}

const params = { params: Promise.resolve({ id: "session-1" }) }
const get = () =>
  GET(new NextRequest("http://localhost/api/admin/tally/session-1"), params)
const remove = () =>
  DELETE(
    new NextRequest("http://localhost/api/admin/tally/session-1", { method: "DELETE" }),
    params,
  )

describe("GET /api/admin/tally/[id]", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    setup(sessionRow("importing", { progress: progress(205) }))
  })

  it("refuses a session without inventory.read", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }

    expect((await get()).status).toBe(401)
    expect(m.db.operations).toHaveLength(0)
  })

  it("returns 404 for a session outside the caller's tenant", async () => {
    setup(null)

    expect((await get()).status).toBe(404)
    expect(
      m.db.operations.filter((operation) => operation.action === "select")[0]?.filters,
    ).toEqual([
      ["id", "session-1"],
      ["tenant_id", "tenant-1"],
    ])
  })

  it("returns the checkpoint and caps the failure list for the workspace", async () => {
    setup(
      sessionRow("importing", {
        format: "xml",
        conversionDate: "2026-04-01",
        preparedAt: "2026-01-01T00:00:00.000Z",
        summary: { company: "Test Pharmacy Ltd", counts: { vouchers: 6 } },
        reconcile: [{ code: "opening", ok: true }],
        progress: progress(205),
      }),
    )

    const res = await get()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      id: "session-1",
      status: "importing",
      sourceSystem: "Tally",
      fileName: "tally.xml",
      totalRows: 6,
      flaggedRows: 2,
      format: "xml",
      conversionDate: "2026-04-01",
      summary: { company: "Test Pharmacy Ltd" },
      reconcile: [{ code: "opening", ok: true }],
      failureCount: 205,
    })
    expect(body.failures).toHaveLength(200)
  })

  it("returns an empty progress payload before the first apply", async () => {
    setup(sessionRow("review", { summary: { company: "Test Pharmacy Ltd" } }))

    const body = await (await get()).json()

    expect(body.progress).toBeNull()
    expect(body.failures).toEqual([])
    expect(body.failureCount).toBe(0)
  })
})

describe("DELETE /api/admin/tally/[id]", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    setup(sessionRow("review"))
  })

  it("refuses a session without inventory.write", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await remove()).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("refuses to discard an applied import", async () => {
    for (const status of ["importing", "complete"]) {
      setup(sessionRow(status))

      const res = await remove()

      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe(
        "An applied import cannot be discarded; reverse the journals instead.",
      )
      expect(m.db.operations.some((operation) => operation.action === "delete")).toBe(false)
    }
  })

  it("keeps the reserved cut-over session resumable instead of deleting it", async () => {
    setup(sessionRow("review"), "session-1")

    const res = await remove()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_IN_PROGRESS" })
    expect(m.db.operations.some((operation) => operation.action === "delete")).toBe(false)
  })

  it("deletes a session that never reached the ledger, scoped to the tenant", async () => {
    const res = await remove()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true })

    const deletion = m.db.operations.find((operation) => operation.action === "delete")
    expect(deletion?.table).toBe("pharmacy_import_sessions")
    expect(filtersOf(deletion!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("returns 404 when there is nothing to delete", async () => {
    setup(null)

    expect((await remove()).status).toBe(404)
  })
})

describe("Tally cut-over kill switch", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    setup(sessionRow("importing", { progress: progress(0) }))
  })

  it("closes the route before it reads the session", async () => {
    process.env.SYNAPSE_TALLY_CUTOVER_ENABLED = "false"
    try {
      const res = await get()

      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_DISABLED" })
      expect(m.db.operations).toHaveLength(0)
    } finally {
      delete process.env.SYNAPSE_TALLY_CUTOVER_ENABLED
    }
  })

  it("still answers an unauthenticated caller with 401 while closed", async () => {
    process.env.SYNAPSE_TALLY_CUTOVER_ENABLED = "false"
    m.auth = { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
    try {
      expect((await get()).status).toBe(401)
    } finally {
      delete process.env.SYNAPSE_TALLY_CUTOVER_ENABLED
    }
  })
})
