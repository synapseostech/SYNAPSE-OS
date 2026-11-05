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
import {
  buildManifestEvidence,
  buildSourceManifest,
  describeStagedDocument,
  isMultiFileSession,
  isTallyCutoverSession,
  readStagedSources,
} from "./manifest"

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

describe("describeStagedDocument", () => {
  it("refuses a file that does not name the company it came from", () => {
    expect(describeStagedDocument(document({ company: undefined }), {})).toMatchObject({
      ok: false,
      code: "TALLY_COMPANY_MISSING",
    })
  })

  it("refuses a file that was cut short before it could be read", () => {
    expect(describeStagedDocument(document({ truncated: true }), {})).toMatchObject({
      ok: false,
      code: "SOURCE_TRUNCATED",
    })
  })

  it("refuses a file holding neither masters nor vouchers", () => {
    expect(describeStagedDocument(document(), {})).toMatchObject({
      ok: false,
      code: "TALLY_FILE_EMPTY",
    })
  })

  it("names the masters chunk and counts every master record it holds", () => {
    const described = describeStagedDocument(
      document({ groups: records(1), ledgers: records(2) }),
      {},
    )

    expect(described).toMatchObject({
      ok: true,
      kind: "masters",
      chunkId: MASTERS_CHUNK_ID,
      range: { from: "2026-01-01", to: "2026-01-10" },
      recordsRead: 3,
      periodSource: "source",
    })
  })

  it("refuses a masters file that holds no master record", () => {
    expect(
      describeStagedDocument(document({ ledgers: [] }), { kind: "masters" }),
    ).toMatchObject({ ok: false, code: "TALLY_MASTERS_EMPTY" })
  })

  it("names a slice by the period the operator asked for, not the year the file states", () => {
    const described = describeStagedDocument(
      document({ vouchers: [voucher("2026-01-03"), voucher("2026-01-07")] }),
      { requestedPeriod: { from: "2026-01-01", to: "2026-03-31" } },
    )

    // The stated period is the company's books; taking it would make every
    // slice claim the whole year and overlap the others.
    expect(described).toMatchObject({
      ok: true,
      kind: "vouchers",
      chunkId: voucherChunkId({ from: "2026-01-01", to: "2026-03-31" }),
      range: { from: "2026-01-01", to: "2026-03-31" },
      periodSource: "requested",
      declaredPeriod: { from: "2026-01-01", to: "2026-01-10" },
    })
  })

  it("falls back to the span of the vouchers when the file states no period", () => {
    const described = describeStagedDocument(
      document({
        financialPeriod: {},
        vouchers: [voucher("2026-01-03"), voucher("2026-01-07")],
      }),
      {},
    )

    expect(described).toMatchObject({
      ok: true,
      range: { from: "2026-01-03", to: "2026-01-07" },
      firstDate: "2026-01-03",
      lastDate: "2026-01-07",
    })
  })

  it("refuses a slice holding a voucher outside the range it would be stored under", () => {
    expect(
      describeStagedDocument(
        document({ vouchers: [voucher("2026-01-03"), voucher("2026-01-07")] }),
        { requestedPeriod: { from: "2026-01-05", to: "2026-01-31" } },
      ),
    ).toMatchObject({ ok: false, code: "TALLY_VOUCHERS_OUTSIDE_RANGE" })
  })

  it("refuses a vouchers file with no period and no dated voucher rather than guessing", () => {
    expect(
      describeStagedDocument(document({ financialPeriod: {} }), { kind: "vouchers" }),
    ).toMatchObject({ ok: false, code: "TALLY_PERIOD_MISSING" })
  })

  it("refuses a file holding both masters and vouchers instead of dropping half of it", () => {
    expect(
      describeStagedDocument(
        document({ ledgers: records(1), vouchers: [voucher("2026-01-03")] }),
        {},
      ),
    ).toMatchObject({ ok: false, code: "TALLY_FILE_COMBINED" })
  })

  it("stages an empty slice when its range is named, so the period still tiles", () => {
    // A month with no transactions is part of the period. Refusing it would
    // leave a hole no other file covers.
    const described = describeStagedDocument(document({ financialPeriod: {} }), {
      kind: "vouchers",
      requestedPeriod: { from: "2026-01-01", to: "2026-01-31" },
    })

    expect(described).toMatchObject({
      ok: true,
      kind: "vouchers",
      chunkId: voucherChunkId({ from: "2026-01-01", to: "2026-01-31" }),
      recordsRead: 0,
    })
  })

  it("takes a file as the kind the operator named", () => {
    const described = describeStagedDocument(
      document({ ledgers: records(1), vouchers: [voucher("2026-01-03")] }),
      { kind: "vouchers", requestedPeriod: { from: "2026-01-01", to: "2026-01-31" } },
    )

    expect(described).toMatchObject({ ok: true, kind: "vouchers", recordsRead: 1 })
  })
})

describe("describeStagedDocument — company entered by the operator", () => {
  it("takes the company entered in the form when the file names none", () => {
    const described = describeStagedDocument(
      document({ company: undefined, ledgers: records(2) }),
      { company: "  Api-Cure Pharma Ltd " },
    )

    expect(described).toMatchObject({
      ok: true,
      kind: "masters",
      company: "Api-Cure Pharma Ltd",
      companySource: "operator",
    })
  })

  it("keeps the company the file names and records where it came from", () => {
    expect(
      describeStagedDocument(document({ ledgers: records(1) }), { company: "" }),
    ).toMatchObject({ ok: true, company: "Demo Pharma", companySource: "file" })
  })

  it("matches a company the operator typed in a different case", () => {
    expect(
      describeStagedDocument(document({ ledgers: records(1) }), { company: "demo pharma" }),
    ).toMatchObject({ ok: true, companySource: "file" })
  })

  it("refuses a file that names a different company from the one entered", () => {
    expect(
      describeStagedDocument(document({ ledgers: records(1) }), { company: "Other Pharma" }),
    ).toMatchObject({ ok: false, code: "TALLY_COMPANY_MISMATCH" })
  })

  it("places a masters file that states no period on the entered period", () => {
    const described = describeStagedDocument(
      document({ company: undefined, financialPeriod: {}, ledgers: records(1) }),
      { company: "Api-Cure Pharma Ltd", fallbackPeriod: { from: "2025-10-01", to: "2026-11-30" } },
    )

    expect(described).toMatchObject({
      ok: true,
      range: { from: "2025-10-01", to: "2026-11-30" },
    })
  })

  it("keeps a slice's own dates rather than the period entered for the cut-over", () => {
    // One range typed into the form would make every slice claim the whole
    // migration and collide with the others.
    const described = describeStagedDocument(
      document({
        company: undefined,
        financialPeriod: {},
        vouchers: [voucher("2026-01-03"), voucher("2026-01-08")],
      }),
      { company: "Api-Cure Pharma Ltd", fallbackPeriod: { from: "2025-10-01", to: "2026-11-30" } },
    )

    expect(described).toMatchObject({
      ok: true,
      range: { from: "2026-01-03", to: "2026-01-08" },
    })
  })
})

describe("buildSourceManifest — company entered by the operator", () => {
  it("builds a manifest from the company entered in the form", () => {
    const result = buildSourceManifest(document({ company: undefined }), {
      ...INPUT,
      company: "Api-Cure Pharma Ltd",
    })

    expect(result.manifest).toMatchObject({
      company: "Api-Cure Pharma Ltd",
      companySource: "operator",
    })
  })

  it("refuses an export that names another company", () => {
    const result = buildSourceManifest(document(), { ...INPUT, company: "Other Pharma" })

    expect(result.manifest).toBeUndefined()
    expect(result.reason).toBe("TALLY_COMPANY_MISMATCH")
  })
})

describe("isMultiFileSession", () => {
  it("is true only once a file has been staged", () => {
    expect(isMultiFileSession({ sources: [{ chunkId: "masters", uploadId: "u1" }] })).toBe(true)
    expect(isMultiFileSession({ sources: [] })).toBe(false)
    expect(isMultiFileSession({ path: "tenants/t/imports/s/source.xml" })).toBe(false)
    expect(isMultiFileSession(null)).toBe(false)
  })
})

describe("readStagedSources", () => {
  it("keeps the entries a page can render and drops the rest", () => {
    const sources = readStagedSources([
      { uploadId: "u1", chunkId: "masters", fileName: "masters.xml" },
      { chunkId: "vouchers:2026-01-01:2026-01-10" },
      { uploadId: "u2" },
      "nonsense",
      null,
    ])

    expect(sources).toEqual([
      { uploadId: "u1", chunkId: "masters", fileName: "masters.xml" },
    ])
    expect(readStagedSources(undefined)).toEqual([])
  })
})
