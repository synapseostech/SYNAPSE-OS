import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { TallySourceError } from "@/lib/tally/source"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  readSource: vi.fn(),
  readDocument: vi.fn(),
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
  return { ...actual, readTallySource: m.readSource }
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

const PLAN = {
  conversionDate: "2026-04-01",
  counts: { vouchers: 6 },
  exceptions: [
    { code: "TALLY_BATCH_NO_EXPIRY", severity: "blocking", message: "One batch has no expiry." },
    { code: "TALLY_CREDIT_SALE", severity: "notice", message: "A credit sale stays in the ledger." },
  ],
  accounts: [
    {
      code: "T-00000001",
      name: "Test Party A",
      sourceName: "Test Party A",
      accountType: "asset",
      normalBalance: "debit",
      role: "accounts_receivable",
      systemKey: null,
      partyType: "customer",
      openingBalance: 100_000,
      openingSide: "debit",
      openingMethod: "opening-balance",
      unclassified: false,
    },
  ],
  parties: [
    {
      kind: "customer",
      name: "Test Party A",
      accountCode: "T-00000001",
      openingBalance: 100_000,
      bills: [{ name: "SAL-0001", amount: 100_000, dueDate: "2025-06-09" }],
    },
  ],
  stockItems: [
    {
      sku: "TALLY-1",
      name: "Test Item A",
      quantity: 100,
      unit: "Strip",
      batches: [
        { expiryDate: "2027-06-30", receivable: true },
        { expiryDate: "2025-01-31", receivable: false },
        { expiryDate: null, receivable: false },
      ],
    },
  ],
  vouchers: [
    {
      sourceId: "guid-1:SAL-0001",
      kind: "sales",
      date: "2025-05-10",
      number: "SAL-0001",
      partyName: "Test Party A",
      lines: [{ debit: 100_000 }],
    },
  ],
  sales: [{ number: "SAL-0001" }],
  purchases: [],
}

function sessionRow(status = "pending", mapping: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status,
    file_name: "tally.xml",
    file_url: "tenants/tenant-1/imports/session-1/source.xml",
    ai_mapping: { format: "xml", path: "tenants/tenant-1/imports/session-1/source.xml", ...mapping },
  }
}

function setup(session: unknown, cutover: unknown = null) {
  m.db = fakeSupabase(
    (operation): FakeResult => {
      const isCutoverQuery = operation.filters.some(
        ([column, value]) => column === "source_system" && value === "Tally",
      )
      if (isCutoverQuery) return { data: cutover, error: null }
      return operation.action === "select"
        ? { data: session, error: null }
        : { data: null, error: null }
    },
  )
}

const params = { params: Promise.resolve({ id: "session-1" }) }
const post = (body?: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/tally/session-1/preview", {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params,
  )

describe("POST /api/admin/tally/[id]/preview", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    m.readSource.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
    m.readDocument.mockReset().mockReturnValue({
      format: "xml",
      document: { currency: "UGX" },
    })
    m.normalise.mockReset().mockReturnValue(PLAN)
    m.writePlan
      .mockReset()
      .mockResolvedValue({
        preparedAt: "2026-01-01T00:00:00.000Z",
        exceptions: [{ code: "TALLY_BATCH_NO_EXPIRY", severity: "blocking", message: "One batch has no expiry." }],
      })
    setup(sessionRow())
  })

  it("refuses a session without inventory.write before touching the database", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await post()).status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("returns 404 for a session outside the caller's tenant", async () => {
    setup(null)

    expect((await post()).status).toBe(404)
    expect(
      m.db.operations.find(
        (operation) =>
          operation.action === "select" &&
          filtersOf(operation).id === "session-1",
      )?.filters,
    ).toEqual([
      ["id", "session-1"],
      ["tenant_id", "tenant-1"],
    ])
  })

  it("refuses to preview once another session has completed the cut-over", async () => {
    setup(sessionRow(), { id: "session-0", completed_at: "2026-01-01T00:00:00.000Z" })

    const res = await post()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TALLY_CUTOVER_COMPLETE" })
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("refuses to re-preview an applied import", async () => {
    for (const status of ["importing", "complete"]) {
      setup(sessionRow(status))

      const res = await post()

      expect(res.status).toBe(409)
      expect(m.readSource).not.toHaveBeenCalled()
    }
  })

  it("refuses to preview before the file is uploaded", async () => {
    setup({ ...sessionRow(), file_url: null, ai_mapping: {} })

    const res = await post()

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("Upload the file before previewing it.")
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("rejects a malformed JSON body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/admin/tally/session-1/preview", {
        method: "POST",
        body: "{not json",
      }),
      params,
    )

    expect(res.status).toBe(400)
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("normalises once, stores the plan and returns the review payload", async () => {
    const res = await post({ conversionDate: "2026-04-01" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(m.normalise).toHaveBeenCalledWith(
      { currency: "UGX" },
      expect.objectContaining({ conversionDate: "2026-04-01", currency: "UGX" }),
    )
    expect(m.writePlan).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "session-1",
      PLAN,
      "xml",
    )

    expect(body.summary).toMatchObject({ preparedAt: "2026-01-01T00:00:00.000Z" })
    expect(body.preview).toMatchObject({
      accountTotal: 1,
      partyTotal: 1,
      stockItemTotal: 1,
      voucherTotal: 1,
      salesTotal: 1,
      purchasesTotal: 0,
    })
    expect(body.preview.stockItems[0]).toMatchObject({
      sku: "TALLY-1",
      batchCount: 3,
      receivableBatches: 1,
      expiredBatches: 1,
    })
    expect(body.preview.parties[0]).toMatchObject({
      kind: "customer",
      name: "Test Party A",
      nextDueDate: "2025-06-09",
    })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      status: "review",
      total_rows: 6,
      flagged_rows: 1,
      ai_mapping: {
        format: "xml",
        path: "tenants/tenant-1/imports/session-1/source.xml",
        conversionDate: "2026-04-01",
      },
    })
    expect(filtersOf(update!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("records the edition the portal reported and warns that it is unverified", async () => {
    const res = await post({ edition: "Tally.ERP 9" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.edition).toMatchObject({ edition: "erp9", label: "Tally.ERP 9", verified: false })
    expect(body.editionProblems).toEqual([
      expect.objectContaining({ code: "TALLY_EDITION_UNVERIFIED", severity: "warning" }),
    ])

    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.edition).toBe("erp9")
    expect(mapping.editionProblems).toEqual([
      expect.objectContaining({ code: "TALLY_EDITION_UNVERIFIED" }),
    ])
  })

  it("records an edition it cannot place as unknown rather than assuming one", async () => {
    const res = await post({ edition: "Tally 7.2" })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.edition).toMatchObject({ edition: "unknown", label: "Unrecognised edition" })
    expect(body.editionProblems).toEqual([
      expect.objectContaining({ code: "TALLY_EDITION_UNKNOWN", severity: "warning" }),
    ])
    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.edition).toBe("unknown")
  })

  it("persists a chunk manifest when the export states its company and period", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: {
        company: "Demo Pharma",
        currency: "UGX",
        financialPeriod: { from: "2026-01-01", to: "2026-01-10" },
        groups: [],
        ledgers: [],
        stockGroups: [],
        stockItems: [],
        units: [],
        godowns: [],
        vouchers: [{ date: "2026-01-05" }],
        warnings: [],
      },
    })

    const res = await post()

    expect(res.status).toBe(200)
    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: { from: "2026-01-01", to: "2026-01-10" },
      periodSource: "source",
    })
    expect(mapping.manifestProblems).toEqual([])
    // Nothing independently counted the vouchers, so the review says so
    // instead of presenting the stated period as evidence.
    expect(mapping.manifestCoverage).toBe("unverified")
  })

  it("returns the coverage evidence the review has to show", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: {
        company: "Demo Pharma",
        currency: "UGX",
        financialPeriod: { from: "2026-01-01", to: "2026-01-10" },
        groups: [],
        ledgers: [],
        stockGroups: [],
        stockItems: [],
        units: [],
        godowns: [],
        vouchers: [{ date: "2026-01-03" }, { date: "2026-01-09" }],
        warnings: [],
      },
    })

    const res = await post({ period: { from: "2026-01-01", to: "2026-01-10" } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.manifest.evidence).toEqual({
      requestedPeriod: { from: "2026-01-01", to: "2026-01-10" },
      declaredPeriod: { from: "2026-01-01", to: "2026-01-10" },
      voucherRange: { firstDate: "2026-01-03", lastDate: "2026-01-09" },
      recordsRead: 2,
      recordsStaged: { accounts: 1, parties: 1, products: 1, vouchers: 1 },
      independentCount: false,
      coverage: "unverified",
    })
    expect(body.manifest.coverage).toBe("unverified")
    expect(body.manifest.manifestUpdatedAt).toBe("2026-01-01T00:00:00.000Z")

    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifestEvidence).toEqual(body.manifest.evidence)
  })

  it("keeps the requested period separate from the one the export states", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: {
        company: "Demo Pharma",
        currency: "UGX",
        financialPeriod: { from: "2026-01-01", to: "2026-01-10" },
        groups: [],
        ledgers: [],
        stockGroups: [],
        stockItems: [],
        units: [],
        godowns: [],
        vouchers: [{ date: "2026-01-05" }],
        warnings: [],
      },
    })

    const res = await post({ period: { from: "2026-01-01", to: "2026-01-31" } })
    const body = await res.json()

    expect(res.status).toBe(200)
    // The export's own dates win, and the difference is a blocking problem;
    // neither fact is folded into the other.
    expect(body.manifest.period).toEqual({ from: "2026-01-01", to: "2026-01-10" })
    expect(body.manifest.periodSource).toBe("source")
    expect(body.manifest.evidence.requestedPeriod).toEqual({ from: "2026-01-01", to: "2026-01-31" })
    expect(body.manifest.evidence.declaredPeriod).toEqual({ from: "2026-01-01", to: "2026-01-10" })
    expect(body.manifest.problems).toEqual([expect.stringContaining("TALLY_PERIOD_MISMATCH")])
  })

  it("stores no manifest, and the reason, when the export names no company", async () => {
    const res = await post()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.manifest).toMatchObject({ period: null, reason: "TALLY_COMPANY_MISSING" })

    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toBeUndefined()
    expect(mapping.manifestReason).toBe("TALLY_COMPANY_MISSING")
    expect(mapping.manifestProblems).toEqual([expect.stringContaining("TALLY_COMPANY_MISSING")])
  })

  it("uses the period the operator asked for when the export states none", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: {
        company: "Demo Pharma",
        currency: "UGX",
        financialPeriod: {},
        groups: [],
        ledgers: [],
        stockGroups: [],
        stockItems: [],
        units: [],
        godowns: [],
        vouchers: [],
        warnings: [],
      },
    })

    const res = await post({ period: { from: "2026-01-01", to: "2026-01-31" } })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.manifest).toMatchObject({
      period: { from: "2026-01-01", to: "2026-01-31" },
      periodSource: "requested",
      declaredPeriod: null,
      coverage: "unverified",
    })

    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifest).toMatchObject({
      period: { from: "2026-01-01", to: "2026-01-31" },
      periodSource: "requested",
    })
    expect(mapping.manifestProblems).toEqual([])
  })

  it("rejects a requested period that is not two real days", async () => {
    for (const period of [
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-03-02", to: "2026-03-01" },
      { from: "2026-03-01" },
      "2026-03-01",
    ]) {
      const res = await post({ period })

      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("TALLY_PERIOD_BODY_INVALID")
    }
    expect(m.readSource).not.toHaveBeenCalled()
  })

  it("records vouchers that fall outside the period the export declares", async () => {
    m.readDocument.mockReturnValue({
      format: "xml",
      document: {
        company: "Demo Pharma",
        currency: "UGX",
        financialPeriod: { from: "2026-01-01", to: "2026-01-10" },
        groups: [],
        ledgers: [],
        stockGroups: [],
        stockItems: [],
        units: [],
        godowns: [],
        vouchers: [{ date: "2025-12-31" }],
        warnings: [],
      },
    })

    const res = await post()

    expect(res.status).toBe(200)
    const update = m.db.operations.find((operation) => operation.action === "update")
    const mapping = (update?.payload as { ai_mapping: Record<string, unknown> }).ai_mapping
    expect(mapping.manifestProblems).toEqual([
      expect.stringContaining("TALLY_VOUCHER_OUTSIDE_PERIOD"),
    ])
  })

  it("parks a truncated source in review with the truncation as a blocking exception", async () => {
    m.normalise.mockReturnValue({
      ...PLAN,
      exceptions: [
        {
          code: "SOURCE_TRUNCATED",
          severity: "blocking",
          message: "The import stopped after 250,000 records.",
        },
      ],
    })
    m.writePlan.mockResolvedValue({
      preparedAt: "2026-01-01T00:00:00.000Z",
      exceptions: [
        {
          code: "SOURCE_TRUNCATED",
          severity: "blocking",
          message: "The import stopped after 250,000 records.",
        },
      ],
    })

    const res = await post()

    expect(res.status).toBe(200)
    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      status: "review",
      flagged_rows: 1,
      ai_summary: "The import stopped after 250,000 records.",
    })
  })

  it("records an unreadable file as a failed session", async () => {
    m.readDocument.mockImplementation(() => {
      throw new TallySourceError("File is not a supported Tally export.", "TALLY_FILE_TYPE_UNSUPPORTED")
    })

    const res = await post()

    expect(res.status).toBe(415)
    expect((await res.json()).code).toBe("TALLY_FILE_TYPE_UNSUPPORTED")

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      status: "failed",
      error_message: "File is not a supported Tally export.",
    })
  })
})
