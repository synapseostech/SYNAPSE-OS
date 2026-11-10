import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import type { TallyApplyProgress } from "@/lib/tally/apply"
import {
  MASTERS_CHUNK_ID,
  createManifest,
  recordChunkResult,
  voucherChunkId,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  loadStagePlan: vi.fn(),
  readReplayTarget: vi.fn(),
  applyChunk: vi.fn(),
  reconcile: vi.fn(),
  leaseStatus: "acquired",
  releaseFails: false,
  lockOwner: "session-1" as string | null,
  lockReadFails: false,
  startUpdateError: false,
  reRead: undefined as unknown,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@/lib/tally/plan", () => ({
  loadStagePlan: m.loadStagePlan,
  readTallyReplayTarget: m.readReplayTarget,
}))
vi.mock("@/lib/tally/reconcile", () => ({ reconcileTallyPlan: m.reconcile }))
vi.mock("@/lib/tally/apply", () => ({
  TALLY_STAGE_ORDER: [
    "accounts",
    "parties",
    "products",
    "opening-journal",
    "opening-stock",
    "journals",
    "complete",
  ],
  emptyProgress: () => progress(),
  applyTallyChunk: m.applyChunk,
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

const PERIOD = { from: "2026-01-01", to: "2026-01-10" }
const MANIFEST_AT = "2026-01-01T00:00:00.000Z"

/** A complete plan whose chunks an independent count confirmed. */
function manifest(complete = true, sessionId = "session-1"): TallyMigrationManifest {
  let value = createManifest({
    sessionId,
    company: "Demo Pharma",
    mode: "opening",
    period: PERIOD,
    updatedAt: MANIFEST_AT,
  })
  if (!complete) return value
  value = recordChunkResult(
    value,
    MASTERS_CHUNK_ID,
    { status: "complete", recordsRead: 0, expectedRecords: 0 },
    MANIFEST_AT,
  )
  return recordChunkResult(
    value,
    voucherChunkId(PERIOD),
    { status: "complete", recordsRead: 10, expectedRecords: 10 },
    MANIFEST_AT,
  )
}

/** Complete, but no independent count read it: Apply must ask first. */
function unverifiedManifest(): TallyMigrationManifest {
  let value = createManifest({
    sessionId: "session-1",
    company: "Demo Pharma",
    mode: "opening",
    period: PERIOD,
    updatedAt: MANIFEST_AT,
  })
  value = recordChunkResult(value, MASTERS_CHUNK_ID, { status: "complete", recordsRead: 0 }, MANIFEST_AT)
  return recordChunkResult(
    value,
    voucherChunkId(PERIOD),
    { status: "complete", recordsRead: 10 },
    MANIFEST_AT,
  )
}

/** A saved plan that reconciles, so each test exercises only its own subject. */
function planSummary(overrides: Record<string, unknown> = {}) {
  return {
    company: "Demo Pharma",
    companyKey: "demo-pharma",
    currency: "UGX",
    conversionDate: "2026-01-10",
    mode: "opening",
    format: "xml",
    counts: {
      ledgers: 4,
      groups: 2,
      stockItems: 1,
      vouchers: 10,
      postedVouchers: 10,
      skippedVouchers: 0,
      sales: 4,
      purchases: 2,
      openingLines: 4,
    },
    opening: { date: "2026-01-01", totalDebit: 100_000, totalCredit: 100_000, difference: 0 },
    stock: {
      openingValue: 50_000,
      closingValue: 50_000,
      itemsWithOpeningValue: 1,
      itemsWithClosingValue: 1,
      itemCount: 1,
    },
    reconciliation: {
      inventoryOpening: 50_000,
      customerOpening: 20_000,
      supplierOpening: 30_000,
      partyReceivable: 20_000,
      partyPayable: 30_000,
      duplicateVouchers: 0,
    },
    exceptions: [],
    chunkCount: 1,
    chunkSize: 250,
    warnings: [],
    preparedAt: MANIFEST_AT,
    ...overrides,
  }
}

const REPLAY_AT = "2026-01-01T00:00:00.000Z"
const REPLAY_ROW_KEY = "reconcile:stock_item:Panadol 500mg"
const REPLAY_REASON = "Tally's closing stock was taken before the last return was posted."

/** A replay whose stock closes ten units below Tally's own figure. */
function replayTarget(overrides: Record<string, unknown> = {}) {
  return {
    preparedAt: REPLAY_AT,
    conversionDate: PERIOD.from,
    cutoffDate: PERIOD.to,
    ordering: "date-then-export-order",
    eventCount: 2,
    movementCount: 2,
    perDay: [{ date: "2026-01-05", events: 2, movements: 2, kinds: { sales: 1, purchase: 1 } }],
    reconciliation: [
      {
        scope: "stock_item",
        key: "Panadol 500mg",
        expected: 90,
        actual: 80,
        difference: -10,
        status: "difference",
        tolerance: 0,
        sourceIds: ["voucher-1"],
      },
    ],
    totals: { match: 0, difference: 1, notAvailable: 0 },
    blocking: 1,
    warnings: 0,
    findings: [],
    simulated: {
      accounts: {},
      items: [],
      sourceIdsByItem: {},
      sourceIdsByAccount: {},
      eventCount: 2,
    },
    ...overrides,
  }
}

// The shape the Tally upload route writes: source_system plus a format, which
// is what marks a session as a cut-over rather than a generic mapped import.
function row(
  status: string,
  mapping: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const saved = mapping.summary
  const ai_mapping: Record<string, unknown> = {
    format: "xml",
    manifest: manifest(),
    manifestProblems: [],
    ...mapping,
  }
  // A test that saves a summary saves a whole one, as preview does; only the
  // figures it is about are overridden.
  if (saved !== undefined && saved !== null && typeof saved === "object") {
    ai_mapping.summary = planSummary(saved as Record<string, unknown>)
  }
  return {
    id: "session-1",
    status,
    source_system: "Tally",
    ai_mapping,
    ...extra,
  }
}

function replaySummary() {
  return { chunkCount: 1, mode: "replay", conversionDate: PERIOD.from }
}

function replaySession() {
  return row("review", { summary: replaySummary() })
}

/** The plan a replay apply reads, mocked so only the gate is on trial. */
function replayPlan() {
  m.loadStagePlan.mockResolvedValue({
    plan: { company: "Demo Pharma" },
    summary: { chunkCount: 1, mode: "replay" },
    chunk: { rows: [] },
    totalChunks: 1,
  })
  m.applyChunk.mockResolvedValue({ progress: progress(), done: false })
}

function setup(session: unknown, auditWriteError?: string) {
  // The route reads the session once before the lease and again under it. A
  // test that supplies `reRead` models another request moving the row between
  // those two reads.
  let sessionReads = 0
  const fake = fakeSupabase((operation): FakeResult => {
    if (
      operation.table === "pharmacy_import_sessions" &&
      operation.action === "update" &&
      m.startUpdateError
    ) {
      return { data: null, error: { message: "session update failed" } }
    }
    if (operation.table === "pharmacy_import_sessions") {
      if (operation.action === "select") {
        sessionReads += 1
        if (sessionReads > 1 && m.reRead !== undefined) return { data: m.reRead, error: null }
      }
      return { data: session, error: null }
    }
    if (operation.table === "pharmacy_tally_cutover_locks") {
      if (m.lockReadFails) return { data: null, error: { message: "lock read failed" } }
      return { data: m.lockOwner ? { session_id: m.lockOwner } : null, error: null }
    }
    if (operation.table === "pharmacy_audit_logs" && operation.action === "insert" && auditWriteError) {
      return { data: null, error: { message: auditWriteError } }
    }
    return { data: null, error: null }
  })
  m.rpcCalls = []
  m.db = {
    ...fake,
    client: {
      ...(fake.client as Record<string, unknown>),
      rpc: async (name: string, args: Record<string, unknown>) => {
        m.rpcCalls.push({ name, args })
        if (name === "claim_pharmacy_tally_cutover_apply") {
          // The function's own rule: only a Tally import may join the cut-over.
          const sourceSystem = (session as { source_system?: unknown } | null)?.source_system
          if (m.leaseStatus === "acquired" && sourceSystem !== "Tally") {
            return { data: "invalid_session", error: null }
          }
          return { data: m.leaseStatus, error: null }
        }
        if (m.releaseFails) return { data: false, error: { message: "lease release failed" } }
        return { data: true, error: null }
      },
    },
  }
}

const params = { params: Promise.resolve({ id: "session-1" }) }
const RAW_URL = "http://localhost/api/admin/tally/session-1/apply"
const post = (body?: unknown) =>
  POST(
    new NextRequest(RAW_URL, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    params,
  )
const postRaw = (body: string) =>
  POST(new NextRequest(RAW_URL, { method: "POST", body }), params)

describe("POST /api/admin/tally/[id]/apply", () => {
  beforeEach(() => {
    m.auth = ADMIN
    m.loadStagePlan.mockReset()
    m.readReplayTarget.mockReset().mockResolvedValue(null)
    m.applyChunk.mockReset()
    m.reconcile.mockReset().mockReturnValue([])
    m.leaseStatus = "acquired"
    m.releaseFails = false
    m.lockOwner = "session-1"
    m.lockReadFails = false
    m.startUpdateError = false
    m.reRead = undefined
    setup(row("review", { summary: { chunkCount: 1 } }))
  })

  it("refuses a session without inventory.adjust before touching the database", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await post()).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("requires reports.financial as well as inventory.adjust", async () => {
    m.auth = {
      ...ADMIN,
      session: {
        user: { id: "user-1" },
        role: "pharmacy_cashier",
        pharmacyRole: "pharmacy_cashier",
        permissions: ["inventory.adjust", "reports.financial"],
        isAdmin: false,
      },
    }

    const res = await post()

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "TALLY_ADMIN_ONLY" })
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

  it("refuses a plan whose opening journal does not balance", async () => {
    setup(
      row("review", {
        summary: {
          chunkCount: 1,
          opening: { date: "2026-01-01", totalDebit: 100_000, totalCredit: 99_000, difference: 1_000 },
        },
      }),
    )

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: "TALLY_PREFLIGHT_BLOCKED",
      state: "blocked",
    })
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
  })

  it("refuses a plan whose customer balances its ledger lines do not carry", async () => {
    setup(
      row("review", {
        summary: {
          chunkCount: 1,
          reconciliation: {
            inventoryOpening: 50_000,
            customerOpening: 20_000,
            supplierOpening: 30_000,
            partyReceivable: 25_000,
            partyPayable: 30_000,
            duplicateVouchers: 0,
          },
        },
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe("TALLY_PREFLIGHT_BLOCKED")
    expect(body.checks).toContainEqual(
      expect.objectContaining({ id: "receivables", status: "fail", blocksApply: true }),
    )
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("does not re-judge the plan of an import already running", async () => {
    setup(
      row("importing", {
        summary: {
          chunkCount: 1,
          opening: { date: "2026-01-01", totalDebit: 100_000, totalCredit: 99_000, difference: 1_000 },
        },
        progress: progress(),
      }),
    )
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Demo Pharma" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({
      progress: progress({ offset: 0 }),
      done: false,
    })

    const res = await post()

    // Resume writes nothing new from the plan; the unreconciled figure is
    // reported after apply, never used to strand a half-written import.
    expect(res.status).toBe(200)
  })

  it("refuses a persisted truncated plan even when flagged_rows is zero", async () => {
    // The summary exactly as the preview persists it into ai_mapping: one JSON
    // round-trip, so nothing depends on an object that only exists in memory.
    const summary = JSON.parse(
      JSON.stringify({
        chunkCount: 1,
        exceptions: [
          {
            code: "SOURCE_TRUNCATED",
            severity: "blocking",
            message: "The import stopped after 250,000 records.",
            detail: "reason=RECORD_LIMIT; recordsProcessed=250000; limit=250000",
          },
        ],
      }),
    )
    setup(row("review", { summary }, { flagged_rows: 0 }))

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_SOURCE_TRUNCATED" })
    // Refused before the plan is loaded, the cut-over lease is taken, or any
    // pharmacy record is written: the only database work is reads.
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.every((operation) => operation.action === "select")).toBe(true)
  })

  it("refuses a migration whose chunks are not all complete", async () => {
    setup(row("review", { summary: { chunkCount: 2 }, manifest: manifest(false) }))

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_MANIFEST_INCOMPLETE" })
    expect(body.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("masters")]),
    )
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
  })

  it("refuses a migration whose vouchers contradicted its declared period", async () => {
    setup(
      row("review", {
        summary: { chunkCount: 1 },
        manifest: manifest(),
        manifestProblems: ["TALLY_VOUCHER_OUTSIDE_PERIOD: 1 voucher date falls outside the export period in this file."],
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_MANIFEST_INCOMPLETE" })
    expect(body.problems).toContain(
      "TALLY_VOUCHER_OUTSIDE_PERIOD: 1 voucher date falls outside the export period in this file.",
    )
    expect(m.loadStagePlan).not.toHaveBeenCalled()
  })

  it("refuses a manifest it cannot read", async () => {
    setup(row("review", { summary: { chunkCount: 1 }, manifest: { version: 1 } }))

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_MANIFEST_INVALID" })
    expect(m.loadStagePlan).not.toHaveBeenCalled()
  })

  it("refuses a Tally session with no manifest and reports why it has none", async () => {
    setup(
      row("review", {
        summary: { chunkCount: 1 },
        manifest: undefined,
        manifestReason: "TALLY_COMPANY_MISSING",
        manifestProblems: ["TALLY_COMPANY_MISSING: this export does not name its company."],
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_COMPANY_MISSING" })
    expect(body.error).toContain("does not name its company")
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
  })

  it("refuses a Tally session with no manifest and no recorded reason", async () => {
    setup(row("review", { summary: { chunkCount: 1 }, manifest: undefined }))

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_MANIFEST_MISSING" })
    expect(body.error).toContain("Preview the file again")
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("refuses a chunk whose count disagrees with the source", async () => {
    let counted = recordChunkResult(
      createManifest({
        sessionId: "session-1",
        company: "Demo Pharma",
        mode: "opening",
        period: PERIOD,
        updatedAt: MANIFEST_AT,
      }),
      MASTERS_CHUNK_ID,
      { status: "complete" },
      MANIFEST_AT,
    )
    counted = recordChunkResult(
      counted,
      voucherChunkId(PERIOD),
      { status: "complete", recordsRead: 3, expectedRecords: 5 },
      MANIFEST_AT,
    )
    setup(row("review", { summary: { chunkCount: 1 }, manifest: counted }))

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_MANIFEST_INCOMPLETE" })
    expect(body.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("TALLY_CHUNK_MISMATCH")]),
    )
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("never asks a generic mapped import for a Tally manifest", async () => {
    // The generic multipart mapper records source_system "Tally" when the form
    // omits one. That alone must not turn an ordinary upload into a cut-over.
    setup(
      row(
        "review",
        {},
        {
          source_system: "Tally",
          ai_mapping: {
            mapping: [],
            sampleRows: [],
            engine: "heuristic_mapper_v1",
            summary: { chunkCount: 1 },
          },
        },
      ),
    )
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Demo Pharma" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: progress(), done: false })

    const res = await post()

    expect(res.status).toBe(200)
    expect(m.loadStagePlan).toHaveBeenCalled()
  })

  it("never asks an import from another source for a Tally manifest", async () => {
    // The lease function only admits a session whose source_system is "Tally",
    // so a session from another source is refused before any plan is loaded.
    setup(
      row(
        "review",
        {},
        {
          source_system: "Sage",
          ai_mapping: { mapping: [], sampleRows: [], summary: { chunkCount: 1 } },
        },
      ),
    )

    const res = await post()

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: "TALLY_SESSION_NOT_FOUND" })
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("applies a session whose manifest is complete", async () => {
    setup(row("review", { summary: { chunkCount: 1 }, manifest: manifest(), manifestProblems: [] }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Demo Pharma" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: progress(), done: false })

    const res = await post()

    expect(res.status).toBe(200)
    expect(m.loadStagePlan).toHaveBeenCalled()
  })

  it("serializes concurrent apply requests for the tenant", async () => {
    m.leaseStatus = "busy"

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_BUSY" })
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(1)
  })

  it("prevents a second session from applying after the one-shot cut-over is reserved", async () => {
    m.leaseStatus = "owned_by_another_session"

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_IN_PROGRESS" })
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("does not re-run a cut-over that completed while the request waited for the lease", async () => {
    const saved = progress({ stage: "complete" })
    m.reRead = row("complete", { progress: saved, reconcile: [{ code: "opening", ok: true }] })

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
    expect(m.rpcCalls.map((call) => call.name)).toEqual([
      "claim_pharmacy_tally_cutover_apply",
      "release_pharmacy_tally_cutover_apply",
    ])
  })

  it("refuses stale state rather than resetting an interrupted import's checkpoint", async () => {
    setup(row("review", { summary: { chunkCount: 3 } }))
    m.reRead = row("importing", {
      summary: { chunkCount: 3 },
      progress: progress({ stage: "journals", offset: 40 }),
    })

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_STATE_CHANGED" })
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
    expect(m.rpcCalls.map((call) => call.name)).toEqual([
      "claim_pharmacy_tally_cutover_apply",
      "release_pharmacy_tally_cutover_apply",
    ])
  })

  it("refuses a plan that was replaced while the request waited for the lease", async () => {
    setup(row("review", { summary: { chunkCount: 1 } }))
    m.reRead = row("review", {
      summary: { chunkCount: 1 },
      manifest: { ...manifest(), updatedAt: "2026-02-01T00:00:00.000Z" },
    })

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_STATE_CHANGED" })
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("resumes a valid interrupted import from its persisted offset", async () => {
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

    const update = m.db.operations.filter((operation) => operation.action === "update").at(-1)
    expect(update?.payload).toMatchObject({
      status: "importing",
      ai_mapping: { progress: { stage: "journals", offset: 80 } },
    })
    // The execution record is written before the first unit of work, so an
    // interrupted step can always be recognised on the next call.
    expect(m.db.operations.filter((operation) => operation.action === "update")[0]?.payload).toMatchObject({
      status: "importing",
      ai_mapping: { progress: { stage: "journals", offset: 40 } },
    })
  })

  it("refuses to resume an importing session that has no manifest", async () => {
    // The old exemption let this session through. A session that cannot show
    // what company and period it covers must not be resumed, and it must not
    // take the lease or write anything while it is refused.
    setup(
      row("importing", {
        summary: { chunkCount: 1 },
        progress: progress({ stage: "journals", offset: 5 }),
        manifest: undefined,
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_MANIFEST_MISSING" })
    expect(body.error).toContain("Contact support")
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses to resume an importing session whose manifest is invalid", async () => {
    setup(
      row("importing", {
        summary: { chunkCount: 1 },
        progress: progress({ stage: "journals", offset: 5 }),
        manifest: { version: 1 },
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_MANIFEST_INVALID" })
    // An importing session cannot be previewed again, so the refusal points at
    // support rather than at a step that would itself be refused.
    expect(body.error).toContain("Contact support")
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses to resume when the stored plan names another session", async () => {
    setup(
      row("importing", {
        summary: { chunkCount: 1 },
        progress: progress({ stage: "journals", offset: 5 }),
        manifest: manifest(true, "session-2"),
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_RESUME_SESSION_MISMATCH" })
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses to resume without a saved execution record", async () => {
    setup(row("importing", { summary: { chunkCount: 1 } }))

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_RESUME_PROGRESS_MISSING" })
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
  })

  it("refuses to resume when the cut-over reservation belongs to another session", async () => {
    m.lockOwner = "session-2"
    setup(
      row("importing", {
        summary: { chunkCount: 1 },
        progress: progress({ stage: "journals", offset: 5 }),
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: "TALLY_RESUME_OWNER_MISMATCH" })
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("fails closed when the cut-over reservation cannot be read", async () => {
    m.lockReadFails = true
    setup(
      row("importing", {
        summary: { chunkCount: 1 },
        progress: progress({ stage: "journals", offset: 5 }),
      }),
    )

    const res = await post()

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_LOCK_UNAVAILABLE" })
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("refuses an unverified migration until the operator acknowledges it", async () => {
    setup(
      row("review", {
        summary: { chunkCount: 1 },
        manifest: unverifiedManifest(),
        manifestEvidence: { recordsRead: 10, coverage: "unverified" },
      }),
    )

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({
      code: "TALLY_UNVERIFIED_NOT_ACKNOWLEDGED",
      coverage: "unverified",
      evidence: { recordsRead: 10, coverage: "unverified" },
    })
    // Nothing reserved, planned or written while the decision is missing.
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("records the acknowledgement without relabelling the coverage", async () => {
    setup(row("review", { summary: { chunkCount: 1 }, manifest: unverifiedManifest() }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Demo Pharma" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: progress(), done: false })

    const res = await post({ acknowledgeUnverified: true })

    expect(res.status).toBe(200)
    const start = m.db.operations.filter((operation) => operation.action === "update")[0]
    const mapping = (start?.payload as { ai_mapping?: Record<string, unknown> }).ai_mapping ?? {}
    const chunks =
      (mapping.manifest as { chunks?: Array<{ reconciliation?: string }> } | undefined)?.chunks ?? []

    expect(mapping.unverifiedAcknowledgement).toMatchObject({
      coverage: "unverified",
      acknowledgedBy: "user-1",
      manifestUpdatedAt: MANIFEST_AT,
    })
    // The chunks are still disclosed as unverified; only the operator's
    // decision was added.
    expect(chunks).not.toHaveLength(0)
    expect(chunks.every((chunk) => chunk.reconciliation === "unverified")).toBe(true)
  })

  it("accepts the acknowledgement saved by an earlier call", async () => {
    setup(
      row("review", {
        summary: { chunkCount: 1 },
        manifest: unverifiedManifest(),
        unverifiedAcknowledgement: {
          coverage: "unverified",
          acknowledgedAt: "2026-01-01T00:00:00.000Z",
          acknowledgedBy: "user-1",
          manifestUpdatedAt: MANIFEST_AT,
        },
      }),
    )
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Demo Pharma" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: progress(), done: false })

    const res = await post()

    expect(res.status).toBe(200)
  })

  it("asks again when the acknowledgement was given for another preview", async () => {
    setup(
      row("review", {
        summary: { chunkCount: 1 },
        manifest: unverifiedManifest(),
        unverifiedAcknowledgement: {
          coverage: "unverified",
          acknowledgedAt: "2025-01-01T00:00:00.000Z",
          acknowledgedBy: "user-1",
          manifestUpdatedAt: "2025-01-01T00:00:00.000Z",
        },
      }),
    )

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_UNVERIFIED_NOT_ACKNOWLEDGED" })
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("does not let an acknowledgement carry an incomplete manifest", async () => {
    // Complete masters, voucher range never read: unverified and unfinished.
    const partial = recordChunkResult(
      createManifest({
        sessionId: "session-1",
        company: "Demo Pharma",
        mode: "opening",
        period: PERIOD,
        updatedAt: MANIFEST_AT,
      }),
      MASTERS_CHUNK_ID,
      { status: "complete", recordsRead: 0 },
      MANIFEST_AT,
    )
    setup(row("review", { summary: { chunkCount: 2 }, manifest: partial }))

    const res = await post({ acknowledgeUnverified: true })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_MANIFEST_INCOMPLETE" })
    expect(m.applyChunk).not.toHaveBeenCalled()
  })

  it("needs no acknowledgement when an independent count verified the plan", async () => {
    setup(row("review", { summary: { chunkCount: 1 }, manifest: manifest() }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Demo Pharma" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: progress(), done: false })

    const res = await post()

    expect(res.status).toBe(200)
    const start = m.db.operations.filter((operation) => operation.action === "update")[0]
    const mapping = (start?.payload as { ai_mapping?: Record<string, unknown> }).ai_mapping ?? {}
    expect(mapping).not.toHaveProperty("unverifiedAcknowledgement")
  })

  it("refuses a replay whose difference nobody has answered", async () => {
    setup(replaySession())
    m.readReplayTarget.mockResolvedValue(replayTarget())

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({
      code: "TALLY_REPLAY_NOT_ACKNOWLEDGED",
      sequenceConfirmed: false,
    })
    expect(body.missing).toEqual([expect.objectContaining({ key: REPLAY_ROW_KEY })])
    // Nothing reserved, planned or written while the review is open.
    expect(m.loadStagePlan).not.toHaveBeenCalled()
    expect(m.rpcCalls).toHaveLength(0)
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses a confirmed sequence while a difference is still unanswered", async () => {
    setup(replaySession())
    m.readReplayTarget.mockResolvedValue(replayTarget())

    const res = await post({ acknowledgeReplay: { sequenceConfirmed: true, items: [] } })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({
      code: "TALLY_REPLAY_NOT_ACKNOWLEDGED",
      sequenceConfirmed: true,
    })
    expect(body.missing).toHaveLength(1)
  })

  it("refuses an acknowledgement whose reason is too short to be one", async () => {
    setup(replaySession())
    m.readReplayTarget.mockResolvedValue(replayTarget())

    const res = await post({
      acknowledgeReplay: { sequenceConfirmed: true, items: [{ key: REPLAY_ROW_KEY, reason: "no" }] },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "TALLY_REPLAY_REASON_TOO_SHORT" })
  })

  it("refuses an answer for a difference this replay does not carry", async () => {
    setup(replaySession())
    m.readReplayTarget.mockResolvedValue(replayTarget())

    const res = await post({
      acknowledgeReplay: {
        sequenceConfirmed: true,
        items: [{ key: "reconcile:account:Bank", reason: REPLAY_REASON }],
      },
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: "TALLY_REPLAY_ACK_UNKNOWN",
      unknown: ["reconcile:account:Bank"],
    })
  })

  it("applies a replay once the sequence is confirmed and every difference answered", async () => {
    setup(replaySession())
    m.readReplayTarget.mockResolvedValue(replayTarget())
    replayPlan()

    const res = await post({
      acknowledgeReplay: {
        sequenceConfirmed: true,
        items: [{ key: REPLAY_ROW_KEY, reason: REPLAY_REASON }],
      },
    })

    expect(res.status).toBe(200)
    const start = m.db.operations.filter((operation) => operation.action === "update")[0]
    const mapping = (start?.payload as { ai_mapping?: Record<string, unknown> }).ai_mapping ?? {}
    expect(mapping.replayAcknowledgement).toMatchObject({
      preparedAt: REPLAY_AT,
      sequenceConfirmed: true,
      acknowledgedBy: "user-1",
      items: [{ key: REPLAY_ROW_KEY, reason: REPLAY_REASON }],
    })
  })

  it("honours the acknowledgement saved by an earlier call", async () => {
    setup(
      row("review", {
        summary: replaySummary(),
        replayAcknowledgement: {
          preparedAt: REPLAY_AT,
          sequenceConfirmed: true,
          acknowledgedAt: "2026-01-01T01:00:00.000Z",
          acknowledgedBy: "user-1",
          items: [{ key: REPLAY_ROW_KEY, reason: REPLAY_REASON }],
        },
      }),
    )
    m.readReplayTarget.mockResolvedValue(replayTarget())
    replayPlan()

    expect((await post()).status).toBe(200)
  })

  it("asks again when the acknowledgement was given for another preview", async () => {
    setup(
      row("review", {
        summary: replaySummary(),
        replayAcknowledgement: {
          preparedAt: "2025-12-31T00:00:00.000Z",
          sequenceConfirmed: true,
          acknowledgedAt: "2025-12-31T01:00:00.000Z",
          acknowledgedBy: "user-1",
          items: [{ key: REPLAY_ROW_KEY, reason: REPLAY_REASON }],
        },
      }),
    )
    m.readReplayTarget.mockResolvedValue(replayTarget())

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_REPLAY_NOT_ACKNOWLEDGED" })
  })

  it("does not re-judge a replay that is already running", async () => {
    setup(
      row("importing", {
        summary: replaySummary(),
        progress: progress({ stage: "accounts" }),
      }),
    )
    // The gate would refuse this target if it were judged.
    m.readReplayTarget.mockResolvedValue(replayTarget())
    replayPlan()

    expect((await post()).status).toBe(200)
  })

  it("reads the replay target only for this session and tenant", async () => {
    setup(replaySession())
    m.readReplayTarget.mockResolvedValue(replayTarget())

    await post()

    expect(m.readReplayTarget).toHaveBeenCalledTimes(1)
    const [, tenantArg, idArg] = m.readReplayTarget.mock.calls[0] ?? []
    expect(tenantArg).toBe("tenant-1")
    expect(idArg).toBe("session-1")
  })

  it("refuses a malformed apply body before reading the session", async () => {
    const res = await postRaw("{")

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "TALLY_APPLY_BODY_INVALID" })
    expect(m.db.operations).toHaveLength(0)
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

    const update = m.db.operations.filter((operation) => operation.action === "update").at(-1)
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
    // Provenance: which company, which edition, which session — not only counts.
    expect((audit?.payload as { details: string }).details).toContain(
      'source company "Demo Pharma"',
    )
    expect((audit?.payload as { details: string }).details).toContain("session session-1")
    expect(m.rpcCalls.map((call) => call.name)).toEqual([
      "claim_pharmacy_tally_cutover_apply",
      "release_pharmacy_tally_cutover_apply",
    ])
  })

  it("does not mark the cut-over complete when its audit write fails", async () => {
    const done = progress({ stage: "complete" })
    setup(
      row("importing", {
        summary: { chunkCount: 1 },
        progress: progress({ stage: "journals" }),
      }),
      "audit write failed",
    )
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: done, done: true })
    m.reconcile.mockReturnValue([])

    const res = await post()
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toMatchObject({ code: "TALLY_AUDIT_FAILED" })
    const updates = m.db.operations.filter((operation) => operation.action === "update")
    expect(updates.at(-1)?.payload).toMatchObject({ status: "importing" })
    expect(updates.some((operation) => (operation.payload as { status?: string }).status === "complete")).toBe(false)
  })

  it("surfaces lease release failures instead of reporting a clean apply", async () => {
    m.releaseFails = true
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    m.applyChunk.mockResolvedValue({ progress: progress({ stage: "journals" }), done: false })

    const res = await post()

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_LOCK_RELEASE_FAILED" })
  })

  it("releases the lease when the session cannot be reserved for apply", async () => {
    m.startUpdateError = true

    const res = await post()

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: "TALLY_CHECKPOINT_SAVE_FAILED" })
    expect(m.applyChunk).not.toHaveBeenCalled()
    expect(m.rpcCalls.map((call) => call.name)).toEqual([
      "claim_pharmacy_tally_cutover_apply",
      "release_pharmacy_tally_cutover_apply",
    ])
  })

  it("does not treat the string \"true\" as the operator's acknowledgement", async () => {
    setup(row("review", { summary: { chunkCount: 1 }, manifest: unverifiedManifest() }))

    const res = await post({ acknowledgeUnverified: "true" })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_UNVERIFIED_NOT_ACKNOWLEDGED" })
    expect(m.applyChunk).not.toHaveBeenCalled()
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

    const update = m.db.operations.filter((operation) => operation.action === "update").at(-1)
    expect(update?.payload).toMatchObject({
      error_message: 'Apply stopped in the "accounts" step: TALLY_PLAN_MISSING: chunk file missing',
      ai_mapping: { progress: expect.objectContaining({ stage: "accounts" }) },
    })
    expect(filtersOf(update!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("logs the step before running it so a killed request still names it", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {})
    setup(row("review", { summary: { chunkCount: 1 }, progress: progress({ stage: "journals", offset: 3 }) }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 5 },
      chunk: { rows: [] },
      totalChunks: 5,
    })
    m.applyChunk.mockResolvedValue({ progress: progress({ stage: "journals", offset: 4 }), done: false })

    await post()

    const line = logged.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes("tally.apply.step"))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.replace("[pharmacy][tally] ", ""))).toMatchObject({
      event: "tally.apply.step",
      sessionId: "session-1",
      tenantId: "tenant-1",
      stage: "journals",
      offset: 3,
      counts: { journals: 0 },
      failures: 0,
    })
    logged.mockRestore()
  })

  it("logs the stage, the item and the SQLSTATE a step failed on", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    setup(row("review", { summary: { chunkCount: 1 }, progress: progress() }))
    m.loadStagePlan.mockResolvedValue({
      plan: { company: "Test Pharmacy Ltd" },
      summary: { chunkCount: 1 },
      chunk: { rows: [] },
      totalChunks: 1,
    })
    const refused = Object.assign(new Error("permission denied for table pharmacy_accounting_accounts"), {
      name: "TallyApplyStepError",
      stage: "accounts",
      item: "T-1",
      detail: { message: "permission denied for table pharmacy_accounting_accounts", code: "42501" },
    })
    m.applyChunk.mockRejectedValue(refused)

    const res = await post()

    expect(res.status).toBe(500)
    const line = logged.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes("tally.apply.failed"))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.replace("[pharmacy][tally] ", ""))).toMatchObject({
      event: "tally.apply.failed",
      sessionId: "session-1",
      tenantId: "tenant-1",
      phase: "apply",
      stage: "accounts",
      failedStage: "accounts",
      failedItem: "T-1",
      dbError: { code: "42501" },
      failureCount: 0,
    })
    logged.mockRestore()
  })
})
