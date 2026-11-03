/**
 * Builds the migration manifest for one parsed Tally source.
 *
 * The manifest is derived from what the source states about itself, plus the
 * period the operator asked for when the source states none. Nothing is
 * assumed on the operator's behalf: a file that does not name its company or
 * the period it covers yields no manifest and an explicit reason, and Apply
 * refuses it rather than guessing.
 *
 * A stated period is metadata, never proof. `coverage` stays `unverified`
 * unless an independent source count confirms what was parsed — Tally's export
 * reports no such count today, so in practice a freshly built manifest is
 * always unverified until a reconciliation supplies one.
 */

import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import {
  MASTERS_CHUNK_ID,
  canApplyManifest,
  createManifest,
  dateSpan,
  parseTallyIsoDate,
  recordChunkResult,
  sameRange,
  voucherChunkId,
  voucherDatesOutsidePeriod,
  type TallyDateRange,
  type TallyMigrationManifest,
} from "./chunks"

/** Formats the Tally cut-over flow accepts; a session with one of these is a cut-over. */
export const TALLY_SOURCE_FORMATS = ["xml", "xlsx", "xls", "csv"] as const

/**
 * Whether a session belongs to the Tally cut-over flow.
 *
 * `source_system` alone is not enough: the generic mapper records a multipart
 * upload as "Tally" when the form omits a source, and those sessions must never
 * be held to cut-over evidence rules. The Tally upload writes `ai_mapping.format`
 * for every file it accepts, and nothing else writes that field, so it is the
 * marker that actually distinguishes the two flows.
 */
export function isTallyCutoverSession(input: {
  source_system?: string | null
  ai_mapping?: unknown
}): boolean {
  const mapping =
    typeof input.ai_mapping === "object" && input.ai_mapping !== null
      ? (input.ai_mapping as Record<string, unknown>)
      : {}
  const format = typeof mapping.format === "string" ? mapping.format : ""
  if (!(TALLY_SOURCE_FORMATS as readonly string[]).includes(format)) return false
  return input.source_system == null || input.source_system === "Tally"
}

export type TallyManifestReason =
  | "TALLY_COMPANY_MISSING"
  | "TALLY_PERIOD_MISSING"
  | "TALLY_PERIOD_INVALID"

export type TallyManifestBuild = {
  manifest?: TallyMigrationManifest
  /** Set when no manifest could be built; Apply reports it verbatim. */
  reason?: TallyManifestReason
  /** Blocking evidence problems, stored alongside the manifest. */
  problems: string[]
  /** What the manifest's own chunk evidence can claim. */
  coverage?: "verified" | "unverified"
}

/**
 * What the review shows an operator and what Apply requires them to
 * acknowledge. Every value is kept separate on purpose: a period the operator
 * asked for, a period the file stated, and the dates actually read are three
 * different facts, and none of them proves the export was read in full.
 */
export type TallyManifestEvidence = {
  requestedPeriod: TallyDateRange | null
  declaredPeriod: TallyDateRange | null
  voucherRange: { firstDate: string | null; lastDate: string | null }
  recordsRead: number
  recordsStaged: {
    accounts: number
    parties: number
    products: number
    vouchers: number
  } | null
  independentCount: boolean
  coverage: "verified" | "unverified"
}

export function buildManifestEvidence(
  manifest: TallyMigrationManifest,
  input: {
    requestedPeriod?: TallyDateRange
    staged?: TallyManifestEvidence["recordsStaged"]
  } = {},
): TallyManifestEvidence {
  const voucherChunks = manifest.chunks.filter((chunk) => chunk.kind === "vouchers")
  const dates = voucherChunks
    .flatMap((chunk) => [chunk.firstDate, chunk.lastDate])
    .filter((date): date is string => typeof date === "string")
    .sort()

  return {
    requestedPeriod: input.requestedPeriod ? { ...input.requestedPeriod } : null,
    declaredPeriod: manifest.declaredPeriod ? { ...manifest.declaredPeriod } : null,
    voucherRange: {
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
    },
    recordsRead: manifest.chunks.reduce((total, chunk) => total + chunk.recordsRead, 0),
    recordsStaged: input.staged ?? null,
    independentCount: manifest.chunks.some((chunk) => chunk.expectedRecords !== undefined),
    coverage: canApplyManifest(manifest).unverified.length > 0 ? "unverified" : "verified",
  }
}

function parseRange(range: TallyDateRange | undefined): TallyDateRange | undefined {
  if (!range?.from || !range?.to) return undefined
  const start = parseTallyIsoDate(range.from)
  const end = parseTallyIsoDate(range.to)
  if (end < start) throw new Error("TALLY_PERIOD_INVALID")
  return { from: range.from, to: range.to }
}

function reasonMessage(reason: TallyManifestReason): string {
  switch (reason) {
    case "TALLY_COMPANY_MISSING":
      return "This export does not name the Tally company it came from. Re-export with company details included, or use the Tally Bridge, which pins the company."
    case "TALLY_PERIOD_MISSING":
      return "This file does not state the period it covers. Set the period the export was taken for, then preview it again."
    case "TALLY_PERIOD_INVALID":
      return "The period this export states is not a valid date range. Check the export's dates and preview it again."
  }
}

function buildFailure(reason: TallyManifestReason): TallyManifestBuild {
  return { reason, problems: [`${reason}: ${reasonMessage(reason)}`] }
}

export function buildSourceManifest(
  document: TallyXmlDocument,
  input: {
    sessionId: string
    mode: "opening" | "closing"
    now: string
    requestedPeriod?: TallyDateRange
  },
): TallyManifestBuild {
  const company = (document.company ?? "").trim()
  if (!company) return buildFailure("TALLY_COMPANY_MISSING")

  const stated = document.financialPeriod
  const hasStated = Boolean(stated?.from && stated?.to)

  let declaredPeriod: TallyDateRange | undefined
  if (hasStated) {
    try {
      declaredPeriod = parseRange({ from: stated.from as string, to: stated.to as string })
    } catch {
      return buildFailure("TALLY_PERIOD_INVALID")
    }
    if (!declaredPeriod) return buildFailure("TALLY_PERIOD_INVALID")
  }

  let requestedPeriod: TallyDateRange | undefined
  if (input.requestedPeriod) {
    try {
      requestedPeriod = parseRange(input.requestedPeriod)
    } catch {
      return buildFailure("TALLY_PERIOD_INVALID")
    }
  }

  const period = declaredPeriod ?? requestedPeriod
  if (!period) return buildFailure("TALLY_PERIOD_MISSING")

  const problems: string[] = []
  if (declaredPeriod && requestedPeriod && !sameRange(declaredPeriod, requestedPeriod)) {
    problems.push(
      `TALLY_PERIOD_MISMATCH: This file covers ${declaredPeriod.from} to ${declaredPeriod.to}, but ${requestedPeriod.from} to ${requestedPeriod.to} was asked for. Export the whole period again before applying.`,
    )
  }

  let manifest = createManifest({
    sessionId: input.sessionId,
    company,
    mode: input.mode,
    period,
    periodSource: declaredPeriod ? "source" : "requested",
    ...(declaredPeriod ? { declaredPeriod } : {}),
    updatedAt: input.now,
  })

  const failed = document.truncated ? "SOURCE_TRUNCATED" : undefined
  const masterRecords =
    document.ledgers.length +
    document.groups.length +
    document.stockItems.length +
    document.stockGroups.length +
    document.units.length +
    document.godowns.length
  const span = dateSpan(document.vouchers.map((voucher) => voucher.date))

  // One pass both extracts and parses, so there is no separate extraction
  // count to record. `extractedRecords` stays absent rather than echoing the
  // parsed count back, which would look like a second, independent measurement.
  manifest = recordChunkResult(
    manifest,
    MASTERS_CHUNK_ID,
    failed
      ? { status: "failed", error: failed }
      : { status: "complete", recordsRead: masterRecords },
    input.now,
  )
  manifest = recordChunkResult(
    manifest,
    voucherChunkId(period),
    failed
      ? { status: "failed", error: failed }
      : { status: "complete", recordsRead: document.vouchers.length, ...span },
    input.now,
  )

  if (failed) return { manifest, problems, coverage: "unverified" }

  const outside = voucherDatesOutsidePeriod(
    document.vouchers.map((voucher) => voucher.date),
    period,
  )
  if (outside.length > 0) {
    problems.push(
      `TALLY_VOUCHER_OUTSIDE_PERIOD: ${outside.length} voucher date${outside.length === 1 ? "" : "s"} fall outside the ${period.from} to ${period.to} period this migration covers.`,
    )
  }

  const unverified = canApplyManifest(manifest).unverified.length > 0
  return {
    manifest,
    problems,
    coverage: unverified ? "unverified" : "verified",
  }
}
