import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
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
  writeBytes: vi.fn(),
  readStored: vi.fn(),
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
vi.mock("@/lib/tally/consolidate-session", () => ({ readStoredDocument: m.readStored }))

import { DELETE, GET, POST } from "./route"

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

const AT = "2026-11-06T00:00:00.000Z"

function sheetBytes(rows: unknown[][]): Uint8Array {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "StockBatches")
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

const FILLED = sheetBytes([
  ["stock_item", "batch", "expiry", "quantity", "amount", "godown"],
  ["Panadol 500mg", "B-1", "2027-03-31", 24, 12000, ""],
  ["Amoxil 250mg", "", "2027-06-30", 10, "", ""],
])

const MANIFEST: TallyMigrationManifest = recordChunkResult(
  createOpenManifest({
    sessionId: "session-1",
    company: "Demo Pharma",
    mode: "opening",
    period: { from: "2025-10-01", to: "2025-12-31" },
    periodSource: "source",
    updatedAt: AT,
  }),
  "masters",
  { status: "complete", recordsRead: 12, checksum: "abc", bytes: 10 },
  AT,
)

function sessionRow(patch: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status: "pending",
    ai_mapping: { format: "xml", manifest: MANIFEST, sources: [] },
    ...patch,
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

const params = { params: Promise.resolve({ id: "session-1" }) }

const post = (body?: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/tally/session-1/stock-sheet", {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params,
  )

const get = () =>
  GET(new NextRequest("http://localhost/api/admin/tally/session-1/stock-sheet"), params)

const del = () =>
  DELETE(
    new NextRequest("http://localhost/api/admin/tally/session-1/stock-sheet", { method: "DELETE" }),
    params,
  )

beforeEach(() => {
  m.auth = AUTHORISED
  m.readSource.mockReset()
  m.writeBytes.mockReset().mockResolvedValue(FILLED.byteLength)
  m.readStored.mockReset()
  setup(sessionRow())
})

describe("POST /api/admin/tally/[id]/stock-sheet", () => {
  it("refuses a session outside the caller's tenant", async () => {
    setup(null)

    expect((await post()).status).toBe(404)
  })

  it("stores the filled sheet and records it on the session", async () => {
    m.readSource.mockResolvedValue(FILLED)

    const res = await post({ uploadId: "upload-1", fileName: "stock.xlsx" })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      stockSheet: { fileName: "stock.xlsx", rows: 2 },
      problems: [],
    })
    const write = m.db.operations.find((operation) => operation.action === "update")
    expect(write?.payload).toMatchObject({
      ai_mapping: {
        stockSheet: {
          path: "tenants/tenant-1/imports/session-1/stock-sheet.xlsx",
          fileName: "stock.xlsx",
          rows: 2,
        },
      },
    })
    expect(m.writeBytes).toHaveBeenCalledWith(
      expect.anything(),
      "tenants/tenant-1/imports/session-1/stock-sheet.xlsx",
      FILLED,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
  })

  it("makes an existing review stale once a sheet is attached", async () => {
    setup(sessionRow({ status: "review" }))
    m.readSource.mockResolvedValue(FILLED)

    await post({ uploadId: "upload-1", fileName: "stock.xlsx" })

    const write = m.db.operations.find((operation) => operation.action === "update")
    expect(write?.payload).toMatchObject({ status: "pending" })
  })

  it("refuses a workbook that is not a stock sheet", async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["name"]]), "Accounts")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["id"]]), "Vouchers")
    m.readSource.mockResolvedValue(
      new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
    )

    const res = await post({ uploadId: "upload-1", fileName: "stock.xlsx" })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: "TALLY_STOCK_SHEET_MISSING" })
    expect(m.writeBytes).not.toHaveBeenCalled()
  })

  it("accepts only the workbook the operator downloaded", async () => {
    const res = await post({ uploadId: "upload-1", fileName: "stock.xml" })

    expect(res.status).toBe(415)
  })
})

describe("GET /api/admin/tally/[id]/stock-sheet", () => {
  it("refuses before a masters file is staged", async () => {
    setup(sessionRow({ ai_mapping: { format: "xml", sources: [] } }))

    const res = await get()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_STOCK_SHEET_NO_MASTERS" })
  })

  it("downloads a sheet listing the staged items and their opening quantities", async () => {
    m.readStored.mockResolvedValue({
      document: {
        stockItems: [
          { name: "Panadol 500mg", openingQuantity: 24, openingValue: 12000, batchWise: false, batches: [] },
          { name: "Empty Item", openingQuantity: 0, batchWise: false, batches: [] },
        ],
      },
    })

    const res = await get()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet")
    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.StockBatches!, {
      header: 1,
      raw: true,
    })
    expect(rows).toEqual([
      ["stock_item", "batch", "expiry", "quantity", "amount", "godown"],
      ["Panadol 500mg", "", "", 24, 12000, ""],
    ])
  })
})

describe("DELETE /api/admin/tally/[id]/stock-sheet", () => {
  it("detaches the sheet and makes the review stale", async () => {
    setup(
      sessionRow({
        status: "review",
        ai_mapping: {
          format: "xml",
          manifest: MANIFEST,
          stockSheet: { path: "tenants/tenant-1/imports/session-1/stock-sheet.xlsx", rows: 2 },
        },
      }),
    )

    const res = await del()

    expect(res.status).toBe(200)
    const write = m.db.operations.find((operation) => operation.action === "update")
    expect(write?.payload).toMatchObject({ status: "pending" })
    expect((write?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping.stockSheet).toBeUndefined()
    expect(filtersOf(write!)).toMatchObject({ id: "session-1", tenant_id: "tenant-1" })
  })
})
