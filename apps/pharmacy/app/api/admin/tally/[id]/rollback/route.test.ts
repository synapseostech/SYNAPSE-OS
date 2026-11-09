import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { fakeSupabase, filtersOf, type FakeOperation } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  reverseSession: vi.fn(),
  reverseJournals: vi.fn(),
  loadStagePlan: vi.fn(),
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@synapse/db/tally-replay-rpc", () => ({
  reverseTallyReplaySession: m.reverseSession,
}))
vi.mock("@/lib/tally/apply", () => ({
  reverseTallyJournals: m.reverseJournals,
}))
vi.mock("@/lib/tally/plan", () => ({ loadStagePlan: m.loadStagePlan }))
vi.mock("@/lib/tally/http", () => ({
  logTallyEvent: vi.fn(),
  logTallyFailure: vi.fn(),
}))

import { POST } from "./route"

const ADMIN = {
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

const SUMMARY = { companyKey: "company-guid", chunkCount: 2 }

type SessionRow = {
  id: string
  status: string
  source_system: string
  ai_mapping: Record<string, unknown>
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    status: "complete",
    source_system: "Tally",
    ai_mapping: { mode: "replay", summary: SUMMARY },
    ...overrides,
  }
}

function useDb(row: SessionRow | null, options: { statusError?: string } = {}) {
  const fake = fakeSupabase((operation) => {
    if (operation.table === "pharmacy_import_sessions" && operation.action === "select") {
      if (options.statusError) return { data: null, error: { message: options.statusError } }
      return { data: row }
    }
    return { data: null, error: null }
  })
  m.db = { client: fake.client, operations: fake.operations }
  return fake
}

function request() {
  return new NextRequest("http://localhost/api/admin/tally/session-1/rollback", {
    method: "POST",
  })
}

const params = { params: Promise.resolve({ id: "session-1" }) }

function reversedOk(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      movementsReversed: 12,
      companyKey: "company-guid",
      throughDate: "2026-03-31",
      ...overrides,
    },
    error: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.auth = ADMIN
  useDb(session())
  m.reverseSession.mockResolvedValue(reversedOk())
  m.reverseJournals.mockResolvedValue({ posted: 3, failures: [] })
  m.loadStagePlan.mockResolvedValue({
    chunk: { vouchers: [{ sourceType: "voucher", sourceId: "v1" }] },
  })
})

describe("POST tally rollback", () => {
  it("requires the financial-report capability", async () => {
    m.auth = {
      ...ADMIN,
      session: { ...ADMIN.session, role: "cashier", pharmacyRole: "cashier" },
    }
    const response = await POST(request(), params)
    expect(response.status).toBe(403)
    expect(m.reverseSession).not.toHaveBeenCalled()
  })

  it("404s an unknown session", async () => {
    useDb(null)
    const response = await POST(request(), params)
    expect(response.status).toBe(404)
  })

  it("is a no-op when the session was already reversed", async () => {
    useDb(session({ ai_mapping: { reversedAt: "2026-04-01T00:00:00.000Z" } }))
    const response = await POST(request(), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      done: true,
      alreadyReversed: true,
      reversedAt: "2026-04-01T00:00:00.000Z",
    })
    expect(m.reverseSession).not.toHaveBeenCalled()
    expect(m.reverseJournals).not.toHaveBeenCalled()
  })

  it("refuses a session that never finished applying", async () => {
    useDb(session({ status: "processing" }))
    const response = await POST(request(), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "TALLY_ROLLBACK_NOT_COMPLETE" })
    expect(m.reverseSession).not.toHaveBeenCalled()
  })

  it("refuses when the saved plan is missing", async () => {
    useDb(session({ ai_mapping: { mode: "replay" } }))
    const response = await POST(request(), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "TALLY_ROLLBACK_PLAN_MISSING" })
    expect(m.reverseSession).not.toHaveBeenCalled()
  })

  it("reverses nothing when the stock side refuses", async () => {
    m.reverseSession.mockResolvedValue({
      data: null,
      error: {
        code: "TALLY_REVERSAL_ACTIVITY_EXISTS",
        humanMessage: "Trading has been recorded since the cut-over.",
      },
    })
    const response = await POST(request(), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "TALLY_REVERSAL_ACTIVITY_EXISTS" })
    expect(m.reverseJournals).not.toHaveBeenCalled()
    expect(m.db.operations.filter((operation) => operation.action === "update")).toHaveLength(0)
  })

  it("reverses stock, then every journal chunk, then marks the session", async () => {
    const fake = useDb(session())
    const response = await POST(request(), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ done: true, journalsReversed: 6 })
    expect(m.reverseSession).toHaveBeenCalledWith(expect.anything(), "tenant-1", "session-1")
    expect(m.loadStagePlan).toHaveBeenCalledTimes(2)
    expect(m.loadStagePlan).toHaveBeenNthCalledWith(1, expect.anything(), "tenant-1", "session-1", "journals", 0)
    expect(m.loadStagePlan).toHaveBeenNthCalledWith(2, expect.anything(), "tenant-1", "session-1", "journals", 1)

    const update = fake.operations.find(
      (operation) =>
        operation.table === "pharmacy_import_sessions" && operation.action === "update",
    )
    const payload = update?.payload as { ai_mapping: Record<string, unknown> }
    expect(payload.ai_mapping).toMatchObject({ mode: "replay", summary: SUMMARY })
    expect(typeof payload.ai_mapping.reversedAt).toBe("string")
    expect(filtersOf(update!)).toMatchObject({ id: "session-1", tenant_id: "tenant-1" })

    const audit = fake.operations.find((operation) => operation.table === "pharmacy_audit_logs")
    expect(audit?.payload).toMatchObject({
      tenant_id: "tenant-1",
      profile_id: "user-1",
      action: "IMPORT_TALLY_ROLLBACK",
      entity: "IMPORT_SESSION",
      entity_id: "session-1",
    })
  })

  it("stops short of marking the session when a reversing journal is refused", async () => {
    const fake = useDb(session())
    m.reverseJournals
      .mockResolvedValueOnce({
        posted: 0,
        failures: [
          { sourceId: "voucher:v1", code: "ACCOUNTING_PERIOD_CLOSED", message: "Closed period." },
        ],
      })
      .mockResolvedValue({ posted: 3, failures: [] })
    const response = await POST(request(), params)

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: "TALLY_ROLLBACK_INCOMPLETE", failedCount: 1 })
    expect(
      fake.operations.filter((operation) => operation.action === "update"),
    ).toHaveLength(0)
    expect(fake.operations.some((operation) => operation.table === "pharmacy_audit_logs")).toBe(false)
  })

  it("lets a stock-RPC transport failure surface before anything is written", async () => {
    m.reverseSession.mockRejectedValue(new Error("network"))
    await expect(POST(request(), params)).rejects.toThrow("network")
    expect(m.reverseJournals).not.toHaveBeenCalled()
  })
})
