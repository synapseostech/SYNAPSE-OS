import { describe, expect, it } from "vitest"
import type { TallyVoucher, TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import {
  MASTERS_CHUNK_ID,
  canApplyManifest,
  createManifest,
  recordChunkResult,
  voucherChunkId,
  type TallyMigrationManifest,
} from "./chunks"
import { buildManifestEvidence, buildSourceManifest, isTallyCutoverSession } from "./manifest"

const AT = "2026-11-01T00:00:00.000Z"
const INPUT = { sessionId: "session-1", mode: "opening" as const, now: AT }

function voucher(date: string): TallyVoucher {
  return { type: "Sales", date, isCancelled: false, ledgerLines: [], inventoryLines: [] }
}

function records(count: number): TallyXmlDocument["ledgers"] {
  return Array.from({ length: count }, () => ({})) as TallyXmlDocument["ledgers"]
}

function document(overrides: Partial<TallyXmlDocument> = {}): TallyXmlDocument {
  return {
    company: "Demo Pharma",
    financialPeriod: { from: "2026-01-01", to: "2026-01-10" },
    groups: [],
    ledgers: [],
    stockGroups: [],
    stockItems: [],
    units: [],
    godowns: [],
    vouchers: [],
    warnings: [],
    ...overrides,
  }
}

describe("buildSourceManifest", () => {
  it("marks the masters and the declared voucher range complete", () => {
    const result = buildSourceManifest(
      document({ vouchers: [voucher("2026-01-05")] }),
      INPUT,
    )

    expect(result.problems).toEqual([])
    expect(result.manifest).toMatchObject({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: { from: "2026-01-01", to: "2026-01-10" },
      periodSource: "source",
      declaredPeriod: { from: "2026-01-01", to: "2026-01-10" },
    })
    expect(result.manifest?.chunks.map((chunk) => [chunk.kind, chunk.status])).toEqual([
      ["masters", "complete"],
      ["vouchers", "complete"],
    ])
    expect(result.manifest?.chunks[0]?.recordsRead).toBe(0)
    expect(result.manifest?.chunks[1]?.recordsRead).toBe(1)
    expect(result.manifest?.chunks[1]).toMatchObject({
      firstDate: "2026-01-05",
      lastDate: "2026-01-05",
    })
    expect(canApplyManifest(result.manifest!).ok).toBe(true)
  })

  it("never claims a stated period is verified evidence", () => {
    const result = buildSourceManifest(document({ vouchers: [voucher("2026-01-05")] }), INPUT)

    // The file states its period, but nothing independently counted the
    // vouchers, so the coverage is disclosed as unverified rather than
    // upgraded to complete.
    expect(result.coverage).toBe("unverified")
    expect(result.manifest?.chunks.every((chunk) => chunk.reconciliation === "unverified")).toBe(true)
    expect(canApplyManifest(result.manifest!).unverified).toHaveLength(2)
    expect(canApplyManifest(result.manifest!).ok).toBe(true)
  })

  it("counts every master record the parser read", () => {
    const result = buildSourceManifest(
      document({
        ledgers: records(2),
        groups: records(1),
        stockItems: records(1),
        stockGroups: records(1),
        units: records(1),
        godowns: records(1),
      }),
      INPUT,
    )

    expect(result.manifest?.chunks[0]?.recordsRead).toBe(7)
  })

  it("does not invent an extraction count for a single-pass read", () => {
    const result = buildSourceManifest(document({ vouchers: [voucher("2026-01-05")] }), INPUT)

    // Nothing counted the export before parsing, so the chunks carry no
    // extraction count rather than echoing the parsed one back.
    expect(result.manifest?.chunks.every((chunk) => chunk.extractedRecords === undefined)).toBe(true)
  })

  it("carries the cut-over mode it was given", () => {
    const result = buildSourceManifest(document(), { ...INPUT, mode: "closing" })
    expect(result.manifest?.mode).toBe("closing")
  })

  it("uses the requested period when the file states none", () => {
    const result = buildSourceManifest(document({ financialPeriod: {} }), {
      ...INPUT,
      requestedPeriod: { from: "2026-01-01", to: "2026-01-10" },
    })

    expect(result.manifest).toMatchObject({
      period: { from: "2026-01-01", to: "2026-01-10" },
      periodSource: "requested",
    })
    expect(result.manifest?.declaredPeriod).toBeUndefined()
  })

  it("blocks a file that states no period and was asked for none", () => {
    const result = buildSourceManifest(document({ financialPeriod: {} }), INPUT)

    expect(result.manifest).toBeUndefined()
    expect(result.reason).toBe("TALLY_PERIOD_MISSING")
    expect(result.problems[0]).toContain("TALLY_PERIOD_MISSING")
  })

  it("blocks a file that does not name its company", () => {
    const result = buildSourceManifest(document({ company: undefined }), INPUT)

    expect(result.manifest).toBeUndefined()
    expect(result.reason).toBe("TALLY_COMPANY_MISSING")
    expect(result.problems[0]).toContain("TALLY_COMPANY_MISSING")
  })

  it("blocks an impossible stated period", () => {
    const result = buildSourceManifest(
      document({ financialPeriod: { from: "2026-02-30", to: "2026-03-01" } }),
      INPUT,
    )

    expect(result.manifest).toBeUndefined()
    expect(result.reason).toBe("TALLY_PERIOD_INVALID")
  })

  it("reports a file that covers less than the period that was asked for", () => {
    const result = buildSourceManifest(document(), {
      ...INPUT,
      requestedPeriod: { from: "2020-01-01", to: "2026-01-10" },
    })

    expect(result.manifest).toBeDefined()
    expect(result.problems[0]).toContain("TALLY_PERIOD_MISMATCH")
  })

  it("reports vouchers dated outside the period the file declares", () => {
    const result = buildSourceManifest(
      document({
        vouchers: [voucher("2025-12-31"), voucher("2026-01-05"), voucher("2026-01-11")],
      }),
      INPUT,
    )

    expect(result.manifest).toBeDefined()
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain("TALLY_VOUCHER_OUTSIDE_PERIOD")
    expect(result.problems[0]).toContain("2 voucher dates")
    // The chunk's own dates fall outside its range, so the plan blocks even
    // if the stored problems are never read back.
    expect(canApplyManifest(result.manifest!).problems.map((entry) => entry.code)).toContain(
      "TALLY_CHUNK_DATES_OUTSIDE",
    )
  })

  it("records a truncated source as failed rather than complete", () => {
    const result = buildSourceManifest(
      document({
        vouchers: [voucher("2026-01-05")],
        truncated: { reason: "RECORD_LIMIT", limit: 250_000, recordsProcessed: 250_000 },
      }),
      INPUT,
    )

    expect(result.manifest?.chunks.every((chunk) => chunk.status === "failed")).toBe(true)
    expect(result.problems).toEqual([])
    expect(result.coverage).toBe("unverified")
    expect(canApplyManifest(result.manifest!).ok).toBe(false)
  })
})

describe("buildManifestEvidence", () => {
  const RANGE = { from: "2026-01-01", to: "2026-01-10" }

  /** Two complete chunks; `expected` makes them independently verified. */
  function built(input: { read: number; expected?: number[] }): TallyMigrationManifest {
    let manifest = createManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: RANGE,
      updatedAt: AT,
    })
    const mastersExpected = input.expected?.[0]
    const voucherExpected = input.expected?.[1]
    manifest = recordChunkResult(
      manifest,
      MASTERS_CHUNK_ID,
      {
        status: "complete",
        recordsRead: 4,
        ...(mastersExpected !== undefined ? { expectedRecords: mastersExpected } : {}),
      },
      AT,
    )
    return recordChunkResult(
      manifest,
      voucherChunkId(RANGE),
      {
        status: "complete",
        recordsRead: input.read,
        firstDate: "2026-01-02",
        lastDate: "2026-01-08",
        ...(voucherExpected !== undefined ? { expectedRecords: voucherExpected } : {}),
      },
      AT,
    )
  }

  it("adds up what was read and reports the dates the chunks recorded", () => {
    const evidence = buildManifestEvidence(built({ read: 12 }), {
      staged: { accounts: 3, parties: 2, products: 5, vouchers: 12 },
    })

    expect(evidence.recordsRead).toBe(16)
    expect(evidence.voucherRange).toEqual({ firstDate: "2026-01-02", lastDate: "2026-01-08" })
    expect(evidence.recordsStaged).toEqual({ accounts: 3, parties: 2, products: 5, vouchers: 12 })
  })

  it("says no independent count was supplied, and keeps coverage unverified", () => {
    const evidence = buildManifestEvidence(built({ read: 12 }))

    expect(evidence.independentCount).toBe(false)
    expect(evidence.coverage).toBe("unverified")
  })

  it("only calls coverage verified when an independent count matched", () => {
    const evidence = buildManifestEvidence(built({ read: 12, expected: [4, 12] }))

    expect(evidence.independentCount).toBe(true)
    expect(evidence.coverage).toBe("verified")
  })

  it("keeps the requested period separate from the manifest's own period", () => {
    const evidence = buildManifestEvidence(built({ read: 12 }), {
      requestedPeriod: { from: "2025-01-01", to: "2025-01-31" },
    })

    expect(evidence.requestedPeriod).toEqual({ from: "2025-01-01", to: "2025-01-31" })
    expect(evidence.declaredPeriod).toBeNull()
    // The manifest's own period is not exposed here as an implied claim of
    // coverage; it is read from the chunk dates instead.
    expect(evidence.voucherRange).toEqual({ firstDate: "2026-01-02", lastDate: "2026-01-08" })
  })

  it("reports no dates rather than a guessed range when no chunk recorded any", () => {
    const empty = createManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: RANGE,
      updatedAt: AT,
    })
    const evidence = buildManifestEvidence(empty)

    expect(evidence.voucherRange).toEqual({ firstDate: null, lastDate: null })
    expect(evidence.recordsRead).toBe(0)
    expect(evidence.recordsStaged).toBeNull()
  })
})

describe("isTallyCutoverSession", () => {
  const mapping = { format: "xml", path: "tenants/t/imports/s/source.xml" }

  it("recognises a Tally upload", () => {
    expect(isTallyCutoverSession({ source_system: "Tally", ai_mapping: mapping })).toBe(true)
    expect(isTallyCutoverSession({ source_system: null, ai_mapping: mapping })).toBe(true)
  })

  it("recognises the Excel and CSV forms of a Tally export", () => {
    for (const format of ["xlsx", "xls", "csv"]) {
      expect(isTallyCutoverSession({ source_system: "Tally", ai_mapping: { format } })).toBe(true)
    }
  })

  it("does not claim a generic mapped import, even when it says Tally", () => {
    // The generic mapper records a multipart upload as "Tally" when the form
    // omits a source, so the name alone proves nothing.
    expect(
      isTallyCutoverSession({
        source_system: "Tally",
        ai_mapping: { mapping: [], sampleRows: [], engine: "heuristic_mapper_v1" },
      }),
    ).toBe(false)
    expect(
      isTallyCutoverSession({
        source_system: "Sage",
        ai_mapping: { mapping: [], sampleRows: [], engine: "heuristic_mapper_v1" },
      }),
    ).toBe(false)
  })

  it("does not claim a session with no mapping at all", () => {
    expect(isTallyCutoverSession({ source_system: "Tally", ai_mapping: null })).toBe(false)
  })
})
