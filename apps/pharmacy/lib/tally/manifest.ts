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
  type TallyChunkKind,
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
  | "TALLY_COMPANY_MISMATCH"
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

function sameCompany(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** One file staged into a session, as the page lists it back to the operator. */
export type TallyStagedSource = {
  uploadId: string
  fileName: string
  kind: TallyChunkKind
  chunkId: string
  range: TallyDateRange
  recordsRead: number
  bytes: number
  stagedAt: string
}

/**
 * Whether the session's files were staged one by one through the sources
 * endpoint. Preview consolidates the stored chunks in that case, and reads the
 * single `path` only for sessions predating it.
 */
export function isMultiFileSession(mapping: unknown): boolean {
  if (typeof mapping !== "object" || mapping === null) return false
  const sources = (mapping as Record<string, unknown>).sources
  return Array.isArray(sources) && sources.length > 0
}

/** The staged files a session recorded, dropping anything malformed. */
export function readStagedSources(value: unknown): TallyStagedSource[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is TallyStagedSource =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as TallyStagedSource).chunkId === "string" &&
      typeof (entry as TallyStagedSource).uploadId === "string",
  )
}

export type TallyStagedDescription =
  | {
      ok: true
      kind: TallyChunkKind
      chunkId: string
      range: TallyDateRange
      company: string
      recordsRead: number
      periodSource: "source" | "requested"
      /** `operator` when the company came from the form, not from the file. */
      companySource: "file" | "operator"
      declaredPeriod?: TallyDateRange
      firstDate?: string
      lastDate?: string
    }
  | { ok: false; code: string; message: string }

/**
 * Which chunk an uploaded file stands for, derived from what the file says
 * about itself.
 *
 * The range comes from the period the operator asked for, then the period the
 * file states, then the span of the vouchers inside it, then the operator's
 * stated period as a last resort. A vouchers file holding a voucher outside the
 * range it ended up with is refused: staging it would record dates the chunk
 * does not cover, and the manifest would reject that later, after the bytes
 * were already stored.
 *
 * A file that does not name its company takes the one the operator entered,
 * and the result says so. A file that names a different one is refused.
 */
export function describeStagedDocument(
  document: TallyXmlDocument,
  input: {
    requestedPeriod?: TallyDateRange
    fallbackPeriod?: TallyDateRange
    company?: string
    kind?: "masters" | "vouchers"
  },
): TallyStagedDescription {
  const fileCompany = (document.company ?? "").trim()
  const statedCompany = (input.company ?? "").trim()
  if (fileCompany && statedCompany && !sameCompany(fileCompany, statedCompany)) {
    return {
      ok: false,
      code: "TALLY_COMPANY_MISMATCH",
      message: `This file belongs to "${fileCompany}", but "${statedCompany}" was entered for this cut-over.`,
    }
  }
  const company = fileCompany || statedCompany
  if (!company) {
    return {
      ok: false,
      code: "TALLY_COMPANY_MISSING",
      message:
        "This file does not name the Tally company it came from, and none was entered above.",
    }
  }
  if (document.truncated) {
    return {
      ok: false,
      code: "SOURCE_TRUNCATED",
      message: "This file was cut short while it was read. Export it again.",
    }
  }

  const masterRecords =
    document.ledgers.length +
    document.groups.length +
    document.stockItems.length +
    document.stockGroups.length +
    document.units.length +
    document.godowns.length

  const kind: TallyChunkKind | undefined =
    input.kind ??
    (document.vouchers.length > 0
      ? "vouchers"
      : masterRecords > 0 || document.companyGuid
        ? "masters"
        : undefined)
  if (!kind) {
    return {
      ok: false,
      code: "TALLY_FILE_EMPTY",
      message: "This file holds no masters and no vouchers, so there is nothing to import from it.",
    }
  }

  // Staging stores one file per chunk, so a file holding both would have to
  // claim two chunks with bytes neither chunk describes. Refuse it by default
  // rather than silently dropping the half that did not win the guess.
  if (!input.kind && masterRecords > 0 && document.vouchers.length > 0) {
    return {
      ok: false,
      code: "TALLY_FILE_COMBINED",
      message:
        "This file holds both masters and vouchers. Export All Masters and the Day Book separately, then add them as two files.",
    }
  }

  let stated: TallyDateRange | undefined
  if (document.financialPeriod?.from && document.financialPeriod?.to) {
    try {
      stated = parseRange({
        from: document.financialPeriod.from,
        to: document.financialPeriod.to,
      })
    } catch {
      return {
        ok: false,
        code: "TALLY_PERIOD_INVALID",
        message: "The period this file states is not a valid date range.",
      }
    }
  }

  let requested: TallyDateRange | undefined
  if (input.requestedPeriod) {
    try {
      requested = parseRange(input.requestedPeriod)
    } catch {
      return {
        ok: false,
        code: "TALLY_PERIOD_INVALID",
        message: "The period given with this file is not a valid date range.",
      }
    }
  }

  let fallback: TallyDateRange | undefined
  if (input.fallbackPeriod) {
    try {
      fallback = parseRange(input.fallbackPeriod)
    } catch {
      return {
        ok: false,
        code: "TALLY_PERIOD_INVALID",
        message: "The period entered for this cut-over is not a valid date range.",
      }
    }
  }

  if (kind === "masters" && masterRecords === 0) {
    return {
      ok: false,
      code: "TALLY_MASTERS_EMPTY",
      message: "This file holds no accounts, groups or stock items, so it cannot serve as the masters.",
    }
  }

  const span = dateSpan(document.vouchers.map((voucher) => voucher.date))
  const spanned =
    span.firstDate && span.lastDate ? { from: span.firstDate, to: span.lastDate } : undefined

  // The period the operator asked for names the slice. A stated financial year
  // is the company's books, not a slice's bounds: using it for a Day Book range
  // would make every slice claim the whole year and overlap the others. The
  // operator's entered period is last for the same reason.
  const range =
    requested ?? stated ?? (kind === "vouchers" ? spanned : undefined) ?? fallback
  if (!range) {
    return {
      ok: false,
      code: "TALLY_PERIOD_MISSING",
      message:
        kind === "vouchers"
          ? "This file states no period and holds no dated voucher, so the dates it covers cannot be known."
          : "This file states no period. Set the period the export was taken for, then add it again.",
    }
  }

  if (kind === "vouchers") {
    const outside = voucherDatesOutsidePeriod(
      document.vouchers.map((voucher) => voucher.date),
      range,
    )
    if (outside.length > 0) {
      return {
        ok: false,
        code: "TALLY_VOUCHERS_OUTSIDE_RANGE",
        message: `This file holds ${outside.length} voucher date${outside.length === 1 ? "" : "s"} outside the ${range.from} to ${range.to} range it covers.`,
      }
    }
  }

  return {
    ok: true,
    kind,
    chunkId: kind === "masters" ? MASTERS_CHUNK_ID : voucherChunkId(range),
    range,
    company,
    recordsRead: kind === "masters" ? masterRecords : document.vouchers.length,
    periodSource: requested ? "requested" : "source",
    companySource: fileCompany ? "file" : "operator",
    ...(stated ? { declaredPeriod: stated } : {}),
    ...span,
  }
}

function reasonMessage(reason: TallyManifestReason): string {
  switch (reason) {
    case "TALLY_COMPANY_MISSING":
      return "This export does not name the Tally company it came from. Enter the company above and preview it again."
    case "TALLY_COMPANY_MISMATCH":
      return "This export names a different Tally company from the one entered above. Check which company the file came from."
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
    company?: string
  },
): TallyManifestBuild {
  const fileCompany = (document.company ?? "").trim()
  const statedCompany = (input.company ?? "").trim()
  if (fileCompany && statedCompany && !sameCompany(fileCompany, statedCompany)) {
    return buildFailure("TALLY_COMPANY_MISMATCH")
  }
  const company = fileCompany || statedCompany
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
    companySource: fileCompany ? "file" : "operator",
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
