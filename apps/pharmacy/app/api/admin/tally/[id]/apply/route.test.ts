import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import type { TallyApplyProgress } from "@/lib/tally/apply"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  loadStagePlan: vi.fn(),
  applyChunk: vi.fn(),
  reconcile: vi.fn(),
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@/lib/tally/plan", () => ({ loadStagePlan: m.loadStagePlan }))
vi.mock("@/lib/tally/reconcile", () => ({ reconcileTallyPlan: m.reconcile }))
vi.mock("@/lib/tally/apply", () => ({
  emptyProgress: () => progress(),
  applyTallyChunk: m.applyChunk,
}))

import { POST } from "./route"

const ADMIN = {
  ok: true,
  tenantId: "tenant-1",
  session: { user: { id: "user-1" }, pharmacyRole: "pharmacy_admin" },
}

function progress(overrides: Partial<TallyApplyProgress> = {}): TallyApplyProgress {
  return {
    stage: "accounts",
    offset: 0,
    counts: {
      accounts: 0,
      parties: 0,
      products: 0,
      openingJournal: 0,
      openingStock: 0,
      journals: 0,
      sales: 0,
      purchases: 0,
    },
    failures: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function row(
  status: string,
  mapping: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return { id: "session-1", status, ai_mapping: mapping, ...extra }
}

function setup(session: unknown) {
  m.db = fakeSupabase(
    (operation): FakeResult =>
      operation.action === "select" ? { data: session, error: null } : { data: null, error: null },
  )
}

const params = { params: Promise.resolve({ id: "session-1" }) }
const post = () =>
  POST(new NextRequest("http://localhost/api/admin/tally/session-1/apply", { method: "POST" }), params)

describe("POST /api/admin/tally/[id]/apply", () => {
  beforeEach(() => {
    m.auth = ADMIN
    m.loadStagePlan.mockReset()
    m.applyChunk.mockReset()
    m.reconcile.mockReset().mockReturnValue([])
    setup(row("review", { summary: { chunkCount: 1 } }))
  })

  it("refuses a session without inventory.adjust before touching the database", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await post()).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("requires reports.financial as well as inventory.adjust", async () => {
    m.auth = { ...ADMIN, session: { user: { id: "user-1" }, pharmacyRole: "pharmacy_cashier" } }

    const res = await post()

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Missing capability: reports.financial" })
    expect(m.db.operations).toHaveLength(0)
  })

  it("returns 404 for a session belonging to another tenant", async () => {
    setup(null)

    expect((await post()).status).toBe(404)
    expect(
      m.db.operations.filter((operation) => operation.action === "select")[0]?.filters,
    ).toEqual([
      ["id", "session-1"],
      ["tenant_id", "tenant-1"],
    ])
  })

  it("replays a completed import without writing anything again", async () => {
    const saved = progress({ stage: "complete" })
    setup(row("complete", { progress: saved, reconcile: [{ code: "opening", ok: true }] }))

    const res = await post()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      done: true,
      alreadyComplete: true,
      progress: saved,
      reconcile: [{ code: "opening", ok: true }],
    })
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses to apply a session that has not been previewed", async () => {
    setup(row("pending"))

    const res = await post()

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("Preview the file before applying it.")
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("refuses a review session with no stored plan", async () => {
    setup(row("review", {}))

    const res = await post()

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("This session has no reviewed plan. Run the preview again.")
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("refuses a reviewed plan that carries blocking exceptions", async () => {
    setup(row("review", { summary: { chunkCount: 1 } }, { flagged_rows: 2 }))

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_BLOCKING_EXCEPTIONS" })
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("resumes from the persisted offset instead of restarting the stage", async () => {
    setup(
      row("importing", {
        summary: { chunkCount: 3 },
        progress: progress({ stage: "journals", offset: 40 }),
      }),
    )
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 3 },
      chunk: { rows: [] },
      totalChunks: 3,
    })
    m.applyChunk.mockResolvedValue({
      progress: progress({ stage: "journals", offset: 80 }),
      done: false,
    })

    const res = await post()
    const body = await res.json()

    expect(m.loadStagePlan).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "session-1",
      "journals",
      40,
    )
    expect(m.applyChunk).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tenant-1",
        actorId: "user-1",
        chunk: { rows: [] },
        totalChunks: 3,
        progress: expect.objectContaining({ stage: "journals", offset: 40 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ done: false, totalChunks: 3, nextOffset: 80 })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      status: "importing",
      ai_mapping: { progress: { stage: "journals", offset: 80 } },
    })
  })

  it("runs the three master-data stages in one request and stops before the ledger", async () => {
    const stages = ["parties", "products", "opening-journal"] as const
    setup(row("review", { summary: { chunkCount: 9 }, progress: progress() }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 9 },
      chunk: { rows: [] },
      totalChunks: 9,
    })
    m.applyChunk.mockImplementation(async () => ({
      progress: progress({ stage: stages[m.applyChunk.mock.calls.length - 1] }),
      done: false,
    }))

    const res = await post()
    const body = await res.json()

    expect(m.applyChunk).toHaveBeenCalledTimes(3)
    expect(m.loadStagePlan.mock.calls.map((call) => call[3])).toEqual([
      "accounts",
      "parties",
      "products",
    ])
    expect(body.done).toBe(false)
    expect(body.nextOffset).toBeNull()
  })

  it("marks the import complete, records the reconciliation and audits it", async () => {
    const done = progress({
      stage: "complete",
      offset: 0,
      counts: {
        accounts: 8,
        parties: 2,
        products: 2,
        openingJournal: 1,
        openingStock: 1,
        journals: 6,
        sales: 1,
        purchases: 1,
      },
    })
    setup(row("importing", { summary: { chunkCount: 2 }, progress: progress({ stage: "journals" }) }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 2 },
      chunk: { rows: [] },
      totalChunks: 2,
    })
    m.applyChunk.mockResolvedValue({ progress: done, done: true })
    m.reconcile.mockReturnValue([
      { code: "opening-journal", label: "Opening journal", expected: 0, actual: 0, difference: 0, ok: true },
    ])

    const res = await post()
    const body = await res.json()

    expect(body).toMatchObject({
      done: true,
      progress: done,
      reconcile: [expect.objectContaining({ code: "opening-journal", ok: true })],
    })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({ status: "complete" })
    expect((update?.payload as { completed_at?: string }).completed_at).toBeTruthy()

    const audit = m.db.operations.find(
      (operation) => operation.table === "pharmacy_audit_logs" && operation.action === "insert",
    )
    expect(audit?.payload).toMatchObject({
      tenant_id: "tenant-1",
      profile_id: "user-1",
      action: "IMPORT_TALLY",
      entity: "IMPORT_SESSION",
      entity_id: "session-1",
    })
    expect((audit?.payload as { details: string }).details).toContain("6 vouchers")
  })

  it("keeps the checkpoint when a step stops so the next call can resume", async () => {
    setup(row("review", { summary: { chunkCount: 2 }, progress: progress() }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 2 },
      chunk: { rows: [] },
      totalChunks: 2,
    })
    m.applyChunk.mockRejectedValue(new Error("TALLY_PLAN_MISSING: chunk file missing"))

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_PLAN_MISSING", error: "chunk file missing" })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      error_message: "Apply stopped before the step finished.",
      ai_mapping: { progress: expect.objectContaining({ stage: "accounts" }) },
    })
    expect(filtersOf(update!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })
})
