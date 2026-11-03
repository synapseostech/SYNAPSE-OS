import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { createManifest, recordChunkResult, type TallyMigrationManifest } from "@/lib/tally/chunks"
import { fakeSupabase, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  readSource: vi.fn(),
  readDocument: vi.fn(),
  uploadTarget: vi.fn(),
  normalise: vi.fn(),
  writePlan: vi.fn(),
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@/lib/tally/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tally/storage")>()
  return {
    ...actual,
    readTallySource: m.readSource,
    createTallyChunkUploadTarget: m.uploadTarget,
  }
})
vi.mock("@/lib/tally/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tally/source")>()
  return { ...actual, readTallyDocument: m.readDocument }
})
vi.mock("@/lib/tally/plan", () => ({ writeTallyPlan: m.writePlan }))
vi.mock("@synapse/db/tally-normalise", () => ({ normaliseTallyDocument: m.normalise }))

import { POST } from "./route"

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

const PERIOD = { from: "2026-01-01", to: "2026-01-31" }
const COMPANY = "Test Pharmacy"
const MASTERS_PATH = "tenants/tenant-1/imports/session-1/chunks/masters.xml"
const VOUCHER_PATH = "tenants/tenant-1/imports/session-1/chunks/vouchers-2026-01-01-2026-01-31.xml"
const VOUCHER_ID = "vouchers:2026-01-01:2026-01-31"

const PLAN = {
  conversionDate: "2026-04-01",
  counts: { vouchers: 1 },
  exceptions: [] as Array<{ code: string; severity: string; message: string }>,
  accounts: [
    {
      code: "T-1",
      name: "Cash",
      sourceName: "Cash",
      accountType: "asset",
      normalBalance: "debit",
      role: "asset",
      systemKey: null,
      partyType: null,
      openingBalance: 0,
      openingSide: "debit",
      openingMethod: "opening",
      unclassified: false,
    },
  ],
  parties: [{ kind: "customer", name: "Test Party A", accountCode: "T-1", openingBalance: 0, bills: [] }],
  stockItems: [
    { sku: "TALLY-1", name: "Test Item", quantity: 1, unit: "Pcs", value: 10, closingValue: 10, batches: [] },
  ],
  vouchers: [
    {
      sourceId: "guid-1:SAL-0001",
      kind: "sale",
      date: "2026-01-15",
      number: "SAL-0001",
      partyName: "Test Party A",
      lines: [{ debit: 100 }],
    },
  ],
  sales: [],
  purchases: [],
  stock: { openingValue: null, closingValue: null },
}

const SUMMARY = {
  preparedAt: "2026-04-01T00:00:00.000Z",
  exceptions: [] as Array<{ code: string; severity: string; message: string }>,
}

function documentFor(vouchers: Array<Record<string, unknown>> = []) {
  return {
    company: COMPANY,
    financialPeriod: PERIOD,
    groups: [],
    ledgers: [{ guid: "led-1", name: "Cash", isBillWise: false, bills: [] }],
    stockGroups: [],
    stockItems: [],
    units: [],
    godowns: [],
    vouchers,
    warnings: [],
  }
}

function sale(overrides: Record<string, unknown> = {}) {
  return {
    guid: "v-1",
    type: "Sales",
    date: "2026-01-15",
    isCancelled: false,
    ledgerLines: [{ ledgerName: "Sales", amount: 100, side: "credit", isParty: false, bills: [] }],
    inventoryLines: [],
    ...overrides,
  }
}

function manifestWith(overrides: Partial<Parameters<typeof createManifest>[0]> = {}): TallyMigrationManifest {
  return createManifest({
    sessionId: "session-1",
    company: COMPANY,
    mode: "opening",
    period: PERIOD,
    parts: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  })
}

function sessionRow(mapping: Record<string, unknown> = {}, status = "pending") {
  return {
    id: "session-1",
    status,
    file_name: null,
    file_url: null,
    ai_mapping: mapping,
  }
}

function setup(session: unknown, cutover: unknown = null) {
  m.db = fakeSupabase((operation): FakeResult => {
    const isCutoverQuery = operation.filters.some(
      ([column, value]) => column === "source_system" && value === "Tally",
    )
    if (isCutoverQuery) return { data: cutover, error: null }
    return operation.action === "select" ? { data: session, error: null } : { data: null, error: null }
  })
}

function updates(): FakeOperation[] {
  return m.db.operations.filter((operation) => operation.action === "update")
}

const params = { params: Promise.resolve({ id: "session-1" }) }
const post = (body?: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/tally/session-1/extract", {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params,
  )

beforeEach(() => {
  m.auth = AUTHORISED
  m.readSource.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
  m.readDocument.mockReset().mockReturnValue({ format: "xml", document: documentFor() })
  m.uploadTarget.mockReset().mockResolvedValue({
    bucket: "pharmacy-imports",
    path: MASTERS_PATH,
    token: "t",
    signedUrl: "https://storage.test/upload",
  })
  m.normalise.mockReset().mockReturnValue(PLAN)
  m.writePlan.mockReset().mockResolvedValue(SUMMARY)
  setup(sessionRow())
})

describe("POST /api/admin/tally/[id]/extract", () => {
  it("refuses a caller without inventory.write before touching the database", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await post({ action: "status" })).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("refuses an applied import", async () => {
    setup(sessionRow({}, "complete"))

    expect((await post({ action: "status" })).status).toBe(409)
  })

  it("refuses a new extraction once the pharmacy cut-over is complete", async () => {
    setup(sessionRow(), { id: "session-0", completed_at: "2026-01-01T00:00:00.000Z" })

    const res = await post({ action: "begin", company: COMPANY, period: PERIOD })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_COMPLETE" })
    expect(m.uploadTarget).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
  })

  it("builds a manifest of masters plus one range per month from the requested period", async () => {
    const res = await post({ action: "begin", company: COMPANY, period: PERIOD })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.manifest.chunks.map((chunk: { id: string }) => chunk.id)).toEqual([
      "masters",
      VOUCHER_ID,
    ])
    expect(body.manifest.periodSource).toBe("requested")
    expect(body.summary.completeAll).toBe(false)
    // Progress lives in ai_mapping; the session sits in `mapping` until finish.
    expect(updates().some((operation) => (operation.payload as { status?: string }).status === "mapping")).toBe(true)
  })

  it("records the edition the bridge reported and discloses it on every response", async () => {
    const res = await post({
      action: "begin",
      company: COMPANY,
      period: PERIOD,
      edition: "TallyPrime",
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.manifest.edition).toBe("prime")
    expect(body.edition).toMatchObject({ edition: "prime", label: "TallyPrime", verified: false })
    expect(body.editionProblems).toEqual([
      expect.objectContaining({ code: "TALLY_EDITION_UNVERIFIED", severity: "warning" }),
    ])

    // The saved manifest is what a reload reads, so the edition has to be in it.
    setup(sessionRow({ manifest: body.manifest }))
    const status = await (await post({ action: "status" })).json()
    expect(status.manifest.edition).toBe("prime")
    expect(status.edition.edition).toBe("prime")
  })

  it("records an edition it cannot place as unknown", async () => {
    const res = await post({ action: "begin", company: COMPANY, period: PERIOD, edition: "Tally 4.5" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.manifest.edition).toBe("unknown")
    expect(body.editionProblems).toEqual([
      expect.objectContaining({ code: "TALLY_EDITION_UNKNOWN", severity: "warning" }),
    ])
  })

  it("splits a multi-year session into the parts asked for and refuses more than the cap", async () => {
    const period = { from: "2021-01-01", to: "2025-12-31" }

    const res = await post({ action: "begin", company: COMPANY, period, parts: 240 })
    const body = await res.json()

    expect(res.status).toBe(200)
    // One masters chunk, then every range the operator asked for.
    expect(body.manifest.chunks).toHaveLength(241)
    expect(body.manifest.chunks[0].id).toBe("masters")
    expect(body.manifest.chunks[1].range.from).toBe("2021-01-01")
    expect(body.manifest.chunks.at(-1).range.to).toBe("2025-12-31")
    expect(body.summary.completeAll).toBe(false)

    const tooMany = await post({ action: "begin", company: COMPANY, period, parts: 241 })
    expect(tooMany.status).toBe(400)
    expect((await tooMany.json()).error).toContain("between 1 and 240")
  })

  it("refuses a begin with no company, no period, or a balances-only mode", async () => {
    expect((await post({ action: "begin", period: PERIOD })).status).toBe(400)
    expect((await post({ action: "begin", company: COMPANY })).status).toBe(400)
    expect(
      (await post({ action: "begin", company: COMPANY, period: { from: "2026-02-01", to: "2026-01-01" } }))
        .status,
    ).toBe(400)

    const closing = await post({ action: "begin", company: COMPANY, period: PERIOD, mode: "closing" })
    expect(closing.status).toBe(400)
    expect((await closing.json()).code).toBe("TALLY_EXTRACTION_MODE_UNSUPPORTED")
  })

  it("resumes the saved extraction instead of rebuilding it", async () => {
    const manifest = recordChunkResult(manifestWith(), "masters", {
      status: "complete",
      recordsRead: 1,
    })
    setup(sessionRow({ manifest }))

    const res = await post({ action: "begin", company: COMPANY, period: PERIOD })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.manifest.chunks[0].status).toBe("complete")
    expect(updates()).toHaveLength(0)
  })

  it("refuses to resume an extraction for a different company or period", async () => {
    setup(sessionRow({ manifest: manifestWith() }))

    const res = await post({
      action: "begin",
      company: "Another Pharmacy",
      period: PERIOD,
    })

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("TALLY_EXTRACTION_MISMATCH")
  })

  it("refuses a manifest that belongs to another session", async () => {
    setup(sessionRow({ manifest: manifestWith({ sessionId: "session-2" }) }))

    const res = await post({ action: "begin", company: COMPANY, period: PERIOD })

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("TALLY_EXTRACTION_MISMATCH")
  })

  it("hands out a signed upload target for the chunk that was asked for", async () => {
    setup(sessionRow({ manifest: manifestWith() }))

    const res = await post({ action: "target", chunkId: "masters" })

    expect(res.status).toBe(200)
    expect(m.uploadTarget).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tenant-1",
      sessionId: "session-1",
      chunkId: "masters",
    })
  })

  it("refuses a chunk uploaded to a path that is not its own", async () => {
    setup(sessionRow({ manifest: manifestWith() }))

    const res = await post({
      action: "chunk",
      chunkId: "masters",
      path: "tenants/tenant-1/imports/session-1/chunks/other.xml",
    })

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TALLY_CHUNK_PATH_INVALID")
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("records a chunk the server could read as complete, once", async () => {
    setup(sessionRow({ manifest: manifestWith() }))

    const first = await post({ action: "chunk", chunkId: "masters", path: MASTERS_PATH })
    const body = await first.json()

    expect(first.status).toBe(200)
    expect(body.result.status).toBe("complete")
    expect(body.result.recordsRead).toBe(1)
    const saved = updates().at(-1)?.payload as {
      ai_mapping: { manifest: TallyMigrationManifest }
    }
    expect(saved.ai_mapping.manifest.chunks[0]?.status).toBe("complete")

    // The same chunk delivered again is not read a second time.
    const reads = m.readSource.mock.calls.length
    setup(sessionRow({ manifest: body.manifest }))
    const second = await post({ action: "chunk", chunkId: "masters", path: MASTERS_PATH })
    expect((await second.json()).result.status).toBe("complete")
    expect(m.readSource.mock.calls.length).toBe(reads)
  })

  it("fails a chunk whose vouchers fall outside the range that was asked for", async () => {
    setup(sessionRow({ manifest: manifestWith() }))
    m.readDocument.mockReturnValue({
      format: "xml",
      document: documentFor([sale({ date: "2026-02-03" })]),
    })

    const res = await post({ action: "chunk", chunkId: VOUCHER_ID, path: VOUCHER_PATH })
    const body = await res.json()

    expect(body.result.status).toBe("failed")
    expect(body.result.error).toContain("TALLY_CHUNK_DATES_OUTSIDE")
    const saved = updates().at(-1)?.payload as {
      ai_mapping: { manifest: TallyMigrationManifest }
    }
    expect(saved.ai_mapping.manifest.chunks.find((chunk) => chunk.id === VOUCHER_ID)?.status).toBe(
      "failed",
    )
  })

  it("fails a chunk that names a different company", async () => {
    setup(sessionRow({ manifest: manifestWith() }))
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...documentFor(), company: "Another Pharmacy" },
    })

    const body = await (
      await post({ action: "chunk", chunkId: "masters", path: MASTERS_PATH })
    ).json()

    expect(body.result.status).toBe("failed")
    expect(body.result.error).toBe("TALLY_BRIDGE_COMPANY_MISMATCH")
  })

  it("will not reopen a chunk that is already complete", async () => {
    const manifest = recordChunkResult(manifestWith(), "masters", {
      status: "complete",
      recordsRead: 1,
    })
    setup(sessionRow({ manifest }))

    for (const action of ["start", "fail"]) {
      const res = await post({ action, chunkId: "masters", error: "late" })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.manifest.chunks[0].status).toBe("complete")
    }
    expect(updates()).toHaveLength(0)
  })

  it("refuses to finish while any chunk is unread", async () => {
    setup(sessionRow({ manifest: manifestWith() }))

    const res = await post({ action: "finish" })

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("TALLY_EXTRACTION_INCOMPLETE")
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("consolidates the chunks, stages the plan and leaves the migration unverified", async () => {
    let manifest = manifestWith()
    manifest = recordChunkResult(manifest, "masters", { status: "complete", recordsRead: 1 })
    manifest = recordChunkResult(manifest, VOUCHER_ID, {
      status: "complete",
      recordsRead: 1,
      firstDate: "2026-01-15",
      lastDate: "2026-01-15",
    })
    setup(sessionRow({ manifest }))
    m.readDocument.mockReturnValue({ format: "xml", document: documentFor([sale()]) })

    const res = await post({ action: "finish" })
    const body = await res.json()

    expect(res.status).toBe(200)
    // No independent source count, so the merge cannot claim to be verified.
    expect(body.coverage).toBe("unverified")
    // The same voucher arrived with the masters and with the range; it is one voucher.
    expect(body.consolidation.vouchers.read).toBe(2)
    expect(body.consolidation.vouchers.unique).toBe(1)
    expect(m.writePlan).toHaveBeenCalledWith(expect.anything(), "tenant-1", "session-1", PLAN, "xml")

    const review = updates().at(-1)?.payload as {
      status: string
      ai_mapping: { manifestCoverage: string; consolidation: { vouchers: { unique: number } } }
    }
    expect(review.status).toBe("review")
    expect(review.ai_mapping.manifestCoverage).toBe("unverified")
    expect(review.ai_mapping.consolidation.vouchers.unique).toBe(1)
  })

  it("refuses chunks before an extraction has been started", async () => {
    setup(sessionRow())

    const res = await post({ action: "chunk", chunkId: "masters", path: MASTERS_PATH })

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("TALLY_EXTRACTION_NOT_STARTED")
  })
})
