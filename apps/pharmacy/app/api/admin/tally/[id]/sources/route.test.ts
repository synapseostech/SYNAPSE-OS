import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"
import {
  createOpenManifest,
  recordChunkResult,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  readSource: vi.fn(),
  readDocument: vi.fn(),
  writeBytes: vi.fn(),
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
    writeTallySourceBytes: m.writeBytes,
  }
})
vi.mock("@/lib/tally/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tally/source")>()
  return { ...actual, readTallyDocument: m.readDocument }
})

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

const BYTES = new Uint8Array([1, 2, 3, 4])

const MASTERS = {
  company: "Demo Pharma",
  currency: "UGX",
  financialPeriod: { from: "2024-01-01", to: "2026-03-31" },
  groups: [{ name: "Assets" }],
  ledgers: [{ name: "Cash" }, { name: "Sales" }],
  stockGroups: [],
  stockItems: [],
  units: [],
  godowns: [],
  vouchers: [],
  warnings: [],
}

const DAY_BOOK = {
  company: "Demo Pharma",
  currency: "UGX",
  financialPeriod: { from: "2025-01-01", to: "2025-03-31" },
  groups: [],
  ledgers: [],
  stockGroups: [],
  stockItems: [],
  units: [],
  godowns: [],
  vouchers: [{ date: "2025-02-01" }, { date: "2025-03-05" }],
  warnings: [],
}

function sessionRow(mapping: Record<string, unknown> = {}, status = "pending") {
  return {
    id: "session-1",
    status,
    file_name: "all-masters.xml",
    ai_mapping: { format: "xml", ...mapping },
  }
}

/** The manifest a session holds once its masters file is in. */
function mastersStaged(): TallyMigrationManifest {
  return createOpenManifest({
    sessionId: "session-1",
    company: "Demo Pharma",
    mode: "opening",
    period: { from: "2024-01-01", to: "2026-03-31" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
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

const params = { params: Promise.resolve({ id: "session-1" }) }
const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/tally/session-1/sources", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params,
  )

const upload = {
  uploadId: "1f2e3d4c-5b6a-4f70-8e9d-0a1b2c3d4e5f",
  fileName: "all-masters.xml",
}

function lastUpdate() {
  return m.db.operations.filter((operation) => operation.action === "update").at(-1)
}

describe("POST /api/admin/tally/[id]/sources", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    m.readSource.mockReset().mockResolvedValue(BYTES)
    m.readDocument.mockReset().mockReturnValue({ format: "xml", document: MASTERS })
    m.writeBytes.mockReset().mockResolvedValue(BYTES.byteLength)
    setup(sessionRow())
  })

  it("refuses a session without inventory.write before touching the database", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await post(upload)).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("returns 404 for a session outside the caller's tenant", async () => {
    setup(null)

    expect((await post(upload)).status).toBe(404)
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("refuses to add a file to an applied import", async () => {
    setup(sessionRow({}, "complete"))

    expect((await post(upload)).status).toBe(409)
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("requires an upload reference and a readable file name", async () => {
    expect((await post({ fileName: "all-masters.xml" })).status).toBe(400)
    expect((await post({ uploadId: upload.uploadId, fileName: "notes.txt" })).status).toBe(415)
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("refuses an upload reference that is not a plain id", async () => {
    const res = await post({ ...upload, uploadId: "../../other/session" })

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TALLY_UPLOAD_ID_INVALID")
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("takes only XML when a session is built from several files", async () => {
    const res = await post({ ...upload, fileName: "day-book.csv" })

    expect(res.status).toBe(415)
    expect((await res.json()).code).toBe("TALLY_FILE_TYPE_UNSUPPORTED")
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("stages a masters file as the masters chunk and copies it to that chunk's path", async () => {
    const res = await post(upload)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.source).toMatchObject({
      uploadId: upload.uploadId,
      fileName: "all-masters.xml",
      kind: "masters",
      chunkId: "masters",
      range: { from: "2024-01-01", to: "2026-03-31" },
      recordsRead: 3,
    })
    expect(body.manifest).toEqual({
      period: { from: "2024-01-01", to: "2026-03-31" },
      periodSource: "source",
      problems: expect.any(Array),
    })
    expect(m.writeBytes).toHaveBeenCalledWith(
      expect.anything(),
      "tenants/tenant-1/imports/session-1/chunks/masters.xml",
      BYTES,
    )

    const update = lastUpdate()
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.sources).toHaveLength(1)
    expect(mapping.manifest).toMatchObject({
      sessionId: "session-1",
      company: "Demo Pharma",
      period: { from: "2024-01-01", to: "2026-03-31" },
    })
    expect(filtersOf(update!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("adds a later slice into the same session instead of failing on the gap", async () => {
    setup(sessionRow({ manifest: mastersStaged() }))
    m.readDocument.mockReturnValue({ format: "xml", document: DAY_BOOK })

    const res = await post({ ...upload, fileName: "day-book-q1.xml" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.source).toMatchObject({
      kind: "vouchers",
      chunkId: "vouchers:2025-01-01:2025-03-31",
      range: { from: "2025-01-01", to: "2025-03-31" },
      recordsRead: 2,
    })
    // The period grows to the union of what has arrived so far.
    expect(body.manifest.period).toEqual({ from: "2024-01-01", to: "2026-03-31" })
    // A missing stretch is advice while files are still arriving, never a refusal.
    expect(body.manifest.problems.length).toBeGreaterThan(0)
  })

  it("takes a slice's range from the period the operator asked for", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...DAY_BOOK, financialPeriod: {} },
    })

    const res = await post({
      ...upload,
      fileName: "day-book-q1.xml",
      period: { from: "2025-01-01", to: "2025-03-31" },
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.source).toMatchObject({
      chunkId: "vouchers:2025-01-01:2025-03-31",
      range: { from: "2025-01-01", to: "2025-03-31" },
    })
    expect(body.manifest.periodSource).toBe("requested")
  })

  it("falls back to the span of the vouchers when the file states no period", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...DAY_BOOK, financialPeriod: {} },
    })

    const res = await post({ ...upload, fileName: "day-book-q1.xml" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.source.range).toEqual({ from: "2025-02-01", to: "2025-03-05" })
  })

  it("refuses a file from a different company than the one already staged", async () => {
    setup(sessionRow({ manifest: mastersStaged() }))
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...MASTERS, company: "Another Pharmacy" },
    })

    const res = await post(upload)

    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("TALLY_COMPANY_MISMATCH")
    expect(m.writeBytes).not.toHaveBeenCalled()
  })

  it("refuses a file holding both masters and vouchers instead of dropping half of it", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...MASTERS, vouchers: [{ date: "2025-02-01" }] },
    })

    const res = await post(upload)

    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("TALLY_FILE_COMBINED")
    expect(m.writeBytes).not.toHaveBeenCalled()
  })

  it("treats the same bytes arriving twice as an idempotent retry", async () => {
    const checksum = createHash("sha256").update(BYTES).digest("hex")
    let manifest: TallyMigrationManifest = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: { from: "2024-01-01", to: "2026-03-31" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    manifest = recordChunkResult(
      manifest,
      "masters",
      { status: "complete", recordsRead: 3, checksum },
      "2026-01-01T00:00:00.000Z",
    )
    setup(
      sessionRow({
        manifest,
        sources: [
          {
            uploadId: "old-upload",
            fileName: "all-masters.xml",
            kind: "masters",
            chunkId: "masters",
            range: { from: "2024-01-01", to: "2026-03-31" },
            recordsRead: 3,
            bytes: BYTES.byteLength,
            stagedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    )

    const res = await post(upload)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.duplicate).toBe(true)
    expect(m.writeBytes).not.toHaveBeenCalled()
    expect(m.db.operations.some((operation) => operation.action === "update")).toBe(false)
  })

  it("refuses different bytes for a range already staged until the replacement is asked for", async () => {
    let manifest: TallyMigrationManifest = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: { from: "2024-01-01", to: "2026-03-31" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    manifest = recordChunkResult(
      manifest,
      "masters",
      { status: "complete", recordsRead: 3, checksum: "not-the-same" },
      "2026-01-01T00:00:00.000Z",
    )
    setup(sessionRow({ manifest }))

    const refused = await post(upload)

    expect(refused.status).toBe(409)
    expect((await refused.json()).code).toBe("TALLY_CHUNK_ALREADY_STAGED")
    expect(m.writeBytes).not.toHaveBeenCalled()

    const replaced = await post({ ...upload, replace: true })

    expect(replaced.status).toBe(200)
    expect(m.writeBytes).toHaveBeenCalled()
  })

  it("drops a finished preview when another file arrives", async () => {
    setup(sessionRow({}, "review"))

    const res = await post(upload)

    expect(res.status).toBe(200)
    expect(lastUpdate()?.payload).toMatchObject({ status: "pending", error_message: null })
  })
})
