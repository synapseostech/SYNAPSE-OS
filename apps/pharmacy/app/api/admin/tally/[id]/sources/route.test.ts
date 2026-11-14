import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"
import {
  createOpenManifest,
  ensureChunk,
  recordChunkResult,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import { tallyZipCrc32 } from "@synapse/db/tally-zip"

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

const enc = (value: string) => new TextEncoder().encode(value)

/** Writes a stored-entry archive, the shape the exporter's package arrives in. */
function packageZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const data = Buffer.from(entry.data)
    const crc = tallyZipCrc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, eocd]))
}

const PACKAGE_DATES = ["2025-02-01", "2025-03-05"]

/** A companyless day book, as the exporter writes it, inside the package. */
function packageDayBook(): Uint8Array {
  const vouchers = PACKAGE_DATES.map(
    (date, index) =>
      `<VOUCHER VCHTYPE="Sales" ACTION="Create"><GUID>v-${index}</GUID><DATE>${date.replaceAll("-", "")}</DATE><VOUCHERNUMBER>S-${index}</VOUCHERNUMBER></VOUCHER>`,
  ).join("")
  return enc(
    `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${vouchers}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`,
  )
}

/** The exporter's summary and manifest, beside one monthly export. */
function exportPackage(declaredVouchers = PACKAGE_DATES.length): Uint8Array {
  const xml = packageDayBook()
  return packageZip([
    {
      name: "EXPORT_SUMMARY.txt",
      data: enc(
        "SADIO PHARMACY — TALLY FULL-DETAIL EXPORT\nPeriod requested: 2025-01-01 through 2025-03-31\nCompany: SADIO PHARMACY\nTotal vouchers exported: 2\n",
      ),
    },
    {
      name: "EXPORT_MANIFEST.csv",
      data: enc(
        `"Month","Status","Vouchers","EarliestVoucherDate","LatestVoucherDate","File","Bytes","Error"\n"2025-02","SUCCESS","${declaredVouchers}","2025-02-01","2025-03-05","2025-02-full.xml","${xml.length}",""\n`,
      ),
    },
    { name: "2025-02-full.xml", data: xml },
  ])
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

  it("lets the day book, not the masters file name, decide the period", async () => {
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
    // The masters file name claimed 2024–2026, but what was actually exported
    // is the day book's range. Promising the wider span would invent a gap.
    expect(body.manifest.period).toEqual({ from: "2025-01-01", to: "2025-03-31" })
    // The unfinished masters chunk is still a problem; the invented gap is not.
    expect(
      body.manifest.problems.filter(
        (entry: string) =>
          entry.includes("TALLY_CHUNK_GAP") || entry.includes("TALLY_CHUNK_OUT_OF_RANGE"),
      ),
    ).toEqual([])
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

  it("stages a companyless masters file under the company entered in the form", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...MASTERS, company: undefined, financialPeriod: {} },
    })

    const res = await post({
      ...upload,
      company: "  Api-Cure Pharma Ltd ",
      fallbackPeriod: { from: "2025-10-01", to: "2026-11-30" },
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.source).toMatchObject({
      kind: "masters",
      range: { from: "2025-10-01", to: "2026-11-30" },
    })

    const update = lastUpdate()
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({
      company: "Api-Cure Pharma Ltd",
      companySource: "operator",
      period: { from: "2025-10-01", to: "2026-11-30" },
    })
  })

  it("records the file as the source once a file names the company", async () => {
    setup(
      sessionRow({
        manifest: createOpenManifest({
          sessionId: "session-1",
          company: "Demo Pharma",
          companySource: "operator",
          mode: "opening",
          period: { from: "2024-01-01", to: "2026-03-31" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    )
    m.readDocument.mockReturnValue({ format: "xml", document: DAY_BOOK })

    const res = await post({ ...upload, fileName: "day-book-q1.xml" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.manifest.period).toEqual({ from: "2025-01-01", to: "2025-03-31" })

    const update = lastUpdate()
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({ companySource: "file" })
  })

  it("takes the company and voucher count from a package instead of the form", async () => {
    m.readSource.mockResolvedValue(exportPackage())

    const res = await post({ uploadId: upload.uploadId, fileName: "SADIO-full.zip" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.archive.company).toEqual({ name: "SADIO PHARMACY", source: "EXPORT_SUMMARY.txt" })
    expect(body.archive.reconciliation.status).toBe("verified")

    const mapping = (lastUpdate()?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    const manifest = mapping.manifest as TallyMigrationManifest
    expect(manifest).toMatchObject({ company: "SADIO PHARMACY", companySource: "file" })
    // The manifest's own count is what lets the chunk say its completeness was
    // checked against something other than its own output.
    expect(manifest.chunks.find((chunk) => chunk.kind === "vouchers")).toMatchObject({
      recordsRead: 2,
      expectedRecords: 2,
      reconciliation: "verified",
    })
  })

  it("lets the package's own company outrank one typed into the form", async () => {
    m.readSource.mockResolvedValue(exportPackage())

    const res = await post({
      uploadId: upload.uploadId,
      fileName: "SADIO-full.zip",
      company: "TALLY TEST",
    })

    expect(res.status).toBe(200)
    const mapping = (lastUpdate()?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({ company: "SADIO PHARMACY", companySource: "file" })
  })

  it("replaces a company entered by hand when the package names its own", async () => {
    setup(
      sessionRow({
        manifest: createOpenManifest({
          sessionId: "session-1",
          company: "TALLY TEST",
          companySource: "operator",
          mode: "opening",
          period: { from: "2025-01-01", to: "2025-03-31" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    )
    m.readSource.mockResolvedValue(exportPackage())

    const res = await post({ uploadId: upload.uploadId, fileName: "SADIO-full.zip" })

    expect(res.status).toBe(200)
    const mapping = (lastUpdate()?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({ company: "SADIO PHARMACY", companySource: "file" })
  })

  it("records a package that declares more vouchers than its file holds", async () => {
    m.readSource.mockResolvedValue(exportPackage(3))

    const res = await post({ uploadId: upload.uploadId, fileName: "SADIO-full.zip" })
    const body = await res.json()

    expect(res.status).toBe(200)
    const mapping = (lastUpdate()?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    const manifest = mapping.manifest as TallyMigrationManifest
    expect(manifest.chunks.find((chunk) => chunk.kind === "vouchers")).toMatchObject({
      recordsRead: 2,
      expectedRecords: 3,
      reconciliation: "mismatch",
    })
    expect(body.manifest.problems).toContainEqual(expect.stringContaining("TALLY_CHUNK_MISMATCH"))
  })

  it("attributes a companyless file to the company a package already named", async () => {
    setup(
      sessionRow({
        manifest: createOpenManifest({
          sessionId: "session-1",
          company: "SADIO PHARMACY",
          companySource: "file",
          mode: "opening",
          period: { from: "2025-02-01", to: "2025-03-05" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    )
    // The masters export supplied beside the package names no company of its own.
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...MASTERS, company: undefined },
    })

    const res = await post({ uploadId: upload.uploadId, fileName: "masters.xml" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.source.kind).toBe("masters")
    const mapping = (lastUpdate()?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({ company: "SADIO PHARMACY", companySource: "file" })
  })

  it("refuses a company entered in the form that disagrees with the staged one", async () => {
    setup(sessionRow({ manifest: mastersStaged() }))
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...DAY_BOOK, company: undefined },
    })

    const res = await post({
      ...upload,
      fileName: "day-book-q1.xml",
      company: "Another Pharmacy",
    })

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

  it("collapses a file staged again under a different range into one chunk", async () => {
    // The same export read once as the span of its vouchers and once as the
    // operator's period: two ranges, one file. Keeping both would stage its
    // vouchers twice and the overlap check would refuse the whole set.
    const bytes = enc("<daybook/>")
    const checksum = createHash("sha256").update(bytes).digest("hex")
    m.readSource.mockResolvedValue(bytes)
    m.readDocument.mockReturnValue({
      format: "xml",
      document: { ...DAY_BOOK, vouchers: [{ date: "2025-02-01" }, { date: "2025-02-20" }] },
    })

    let manifest: TallyMigrationManifest = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: { from: "2025-02-01", to: "2025-02-20" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    manifest = ensureChunk(
      manifest,
      {
        kind: "vouchers",
        id: "vouchers:2025-02-01:2025-02-20",
        range: { from: "2025-02-01", to: "2025-02-20" },
      },
      "2026-01-01T00:00:00.000Z",
    )
    manifest = recordChunkResult(
      manifest,
      "vouchers:2025-02-01:2025-02-20",
      {
        status: "complete",
        recordsRead: 2,
        checksum,
        firstDate: "2025-02-01",
        lastDate: "2025-02-20",
      },
      "2026-01-01T00:00:00.000Z",
    )
    setup(
      sessionRow({
        manifest,
        sources: [
          {
            uploadId: "old-upload",
            fileName: "2025-02-full.xml",
            kind: "vouchers",
            chunkId: "vouchers:2025-02-01:2025-02-20",
            range: { from: "2025-02-01", to: "2025-02-20" },
            recordsRead: 2,
            bytes: bytes.byteLength,
            stagedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    )

    const res = await post({
      ...upload,
      fileName: "2025-02-full.xml",
      period: { from: "2025-02-01", to: "2025-02-28" },
    })

    expect(res.status).toBe(200)
    const written = lastUpdate()?.payload.ai_mapping as {
      manifest: TallyMigrationManifest
      sources: Array<{ chunkId: string }>
    }
    expect(written.manifest.chunks.filter((chunk) => chunk.kind === "vouchers").map((chunk) => chunk.id)).toEqual([
      "vouchers:2025-02-01:2025-02-28",
    ])
    expect(written.sources.map((entry) => entry.chunkId)).toEqual([
      "vouchers:2025-02-01:2025-02-28",
    ])
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
