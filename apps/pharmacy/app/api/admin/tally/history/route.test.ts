import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { fakeSupabase, type FakeOperation } from "@/lib/tally/test-db"

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

import { GET } from "./route"

function signedIn(pharmacyRole: string) {
  return {
    ok: true,
    tenantId: "tenant-1",
    session: { user: { id: "user-1" }, role: pharmacyRole, pharmacyRole, permissions: [], isAdmin: false },
  }
}

const request = () => new NextRequest("http://localhost/api/admin/tally/history")

describe("GET /api/admin/tally/history", () => {
  beforeEach(() => {
    m.auth = signedIn("pharmacy_admin")
    m.db = fakeSupabase((operation) => {
      if (operation.table === "pharmacy_import_sessions") {
        return {
          data: [{ id: "session-1", status: "complete", file_name: "daybook.xml", applied_counts: null }],
          error: null,
        }
      }
      return { count: 0, error: null }
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns the history to the pharmacy administrator", async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.sessions[0].id).toBe("session-1")
    expect(m.db.operations.every((operation) => operation.action === "select")).toBe(true)
  })

  it("stays readable after the cut-over is switched off", async () => {
    vi.stubEnv("SYNAPSE_TALLY_CUTOVER_ENABLED", "false")
    expect((await GET(request())).status).toBe(200)
  })

  it("refuses staff who are not the administrator", async () => {
    m.auth = signedIn("pharmacist")
    const response = await GET(request())
    expect(response.status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("answers 404 when no import has been applied", async () => {
    m.db = fakeSupabase(() => ({ data: [], error: null }))
    const response = await GET(request())
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe("TALLY_HISTORY_EMPTY")
  })
})
