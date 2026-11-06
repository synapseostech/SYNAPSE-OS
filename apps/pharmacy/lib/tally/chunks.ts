/**
 * Date-range chunks for one Tally migration session.
 *
 * A company whose export does not fit in one file is read as contiguous
 * voucher ranges under a single session. These rules make a set of ranges safe
 * to reconcile: full coverage of the period, no overlap, a stable id per range
 * so a retry replaces its own entry, and a gate that refuses Apply until every
 * chunk is complete.
 *
 * A period is metadata, not evidence. Knowing that a file claims January to
 * March says nothing about whether January to March was fully exported, so the
 * period a file declares and the completeness of what was read are tracked
 * separately. A chunk is `verified` only when an independent count agrees with
 * what was parsed; with no independent count it stays `unverified`, which is
 * disclosed rather than upgraded to complete.
 *
 * Pure functions; extraction and storage live elsewhere.
 */

import type { TallyEdition } from "./editions"

export const TALLY_MANIFEST_VERSION = 2

export type TallyChunkKind = "masters" | "vouchers"
export type TallyChunkStatus = "pending" | "running" | "complete" | "failed"
export type TallyIsoDate = string

/** Where the migration period came from. */
export type TallyPeriodSource = "source" | "requested"

/**
 * How far the chunk's own counts can be trusted:
 * - `verified`: an independently reported count matches what was parsed
 * - `mismatch`: the two disagree
 * - `unverified`: no independent count exists, so completeness is unknown
 */
export type TallyReconciliation = "verified" | "unverified" | "mismatch"

export type TallyDateRange = {
  from: TallyIsoDate
  to: TallyIsoDate
}

export type TallyMigrationChunk = {
  /** Stable across retries: a retry replaces this entry instead of adding one. */
  id: string
  kind: TallyChunkKind
  range: TallyDateRange
  status: TallyChunkStatus
  attempts: number
  /**
   * Records the export returned for this range, counted before parsing. Absent
   * when nothing counted the export separately: a single-pass read has no
   * extraction count of its own, and it is never filled in from the parsed one.
   */
  extractedRecords?: number
  /** Records the parser produced for this range. */
  recordsRead: number
  /** Count reported by the source itself, when it reports one. */
  expectedRecords?: number
  /** Earliest and latest voucher date actually read in this range. */
  firstDate?: TallyIsoDate
  lastDate?: TallyIsoDate
  reconciliation: TallyReconciliation
  bytes: number
  checksum?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export type TallyMigrationManifest = {
  version: typeof TALLY_MANIFEST_VERSION
  sessionId: string
  company: string
  mode: "opening" | "closing"
  /**
   * Where the company name came from: the export itself, or the operator's
   * entry. Absent on manifests written before the operator could supply one.
   */
  companySource?: "file" | "operator"
  /** The period this migration promises to cover. */
  period: TallyDateRange
  /** `source` when the file stated its period, `requested` when the operator did. */
  periodSource: TallyPeriodSource
  /** The period the file itself stated, when it stated one. */
  declaredPeriod?: TallyDateRange
  /**
   * Which Tally edition the bridge reported. Absent on manifests written before
   * the edition was recorded; `unknown` when the bridge could not tell them
   * apart, which is disclosed rather than assumed to be either.
   */
  edition?: TallyEdition
  chunks: TallyMigrationChunk[]
  updatedAt: string
}

export type TallyManifestProblem = {
  code: string
  message: string
}

export type TallyChunkResult = {
  status: "running" | "complete" | "failed"
  recordsRead?: number
  extractedRecords?: number
  expectedRecords?: number
  firstDate?: string
  lastDate?: string
  bytes?: number
  checksum?: string
  error?: string
}

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Milliseconds for a real calendar day; `2026-02-30` is rejected, not rolled over. */
export function parseTallyIsoDate(value: string): number {
  const match = ISO_DATE.exec(value)
  if (!match) throw new Error("TALLY_DATE_INVALID")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("TALLY_DATE_INVALID")
  }
  return ms
}

function formatIsoDate(ms: number): TallyIsoDate {
  return new Date(ms).toISOString().slice(0, 10)
}

function nextDay(ms: number): number {
  return ms + DAY_MS
}

function rangeStart(range: TallyDateRange): number {
  return parseTallyIsoDate(range.from)
}

function rangeEnd(range: TallyDateRange): number {
  const start = rangeStart(range)
  const end = parseTallyIsoDate(range.to)
  if (end < start) throw new Error("TALLY_PERIOD_INVALID")
  return end
}

export function sameRange(left: TallyDateRange, right: TallyDateRange): boolean {
  return left.from === right.from && left.to === right.to
}

export function rangeContainsDate(range: TallyDateRange, date: string): boolean {
  const at = parseTallyIsoDate(date)
  return at >= rangeStart(range) && at <= rangeEnd(range)
}

export function voucherChunkId(range: TallyDateRange): string {
  return `vouchers:${range.from}:${range.to}`
}

export const MASTERS_CHUNK_ID = "masters"

/**
 * Splits a period into contiguous, inclusive ranges. `parts` is reduced to the
 * number of days rather than producing empty ranges, and the extra days are
 * spread over the first chunks so no range is more than one day longer.
 */
export function splitPeriod(period: TallyDateRange, parts: number): TallyDateRange[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error("TALLY_CHUNK_PARTS_INVALID")
  const start = rangeStart(period)
  const end = rangeEnd(period)
  const days = Math.round((end - start) / DAY_MS) + 1
  const count = Math.min(parts, days)
  const base = Math.floor(days / count)
  const extra = days % count

  const ranges: TallyDateRange[] = []
  let cursor = start
  for (let index = 0; index < count; index += 1) {
    const length = base + (index < extra ? 1 : 0)
    const last = cursor + (length - 1) * DAY_MS
    ranges.push({ from: formatIsoDate(cursor), to: formatIsoDate(last) })
    cursor = last + DAY_MS
  }
  return ranges
}

/** Completeness of one chunk, decided only by an independent count. */
export function reconcileCounts(
  recordsRead: number,
  expectedRecords?: number,
): TallyReconciliation {
  if (expectedRecords === undefined) return "unverified"
  return recordsRead === expectedRecords ? "verified" : "mismatch"
}

function emptyChunk(
  kind: TallyChunkKind,
  id: string,
  range: TallyDateRange,
): TallyMigrationChunk {
  return {
    id,
    kind,
    range,
    status: "pending",
    attempts: 0,
    recordsRead: 0,
    reconciliation: "unverified",
    bytes: 0,
  }
}

/**
 * A manifest whose voucher chunks are added later, one per uploaded file. The
 * masters chunk exists from the start because every session needs one; no
 * voucher range is invented, so nothing claims coverage that was not uploaded.
 */
export function createOpenManifest(input: {
  sessionId: string
  company: string
  mode: "opening" | "closing"
  period: TallyDateRange
  updatedAt: string
  periodSource?: TallyPeriodSource
  declaredPeriod?: TallyDateRange
  edition?: TallyEdition
  companySource?: "file" | "operator"
}): TallyMigrationManifest {
  if (!input.sessionId.trim()) throw new Error("TALLY_MANIFEST_SESSION_MISSING")
  if (!input.company.trim()) throw new Error("TALLY_MANIFEST_COMPANY_MISSING")

  rangeEnd(input.period)
  const declaredPeriod = input.declaredPeriod
  return {
    version: TALLY_MANIFEST_VERSION,
    sessionId: input.sessionId,
    company: input.company,
    ...(input.companySource ? { companySource: input.companySource } : {}),
    mode: input.mode,
    period: { from: input.period.from, to: input.period.to },
    periodSource: input.periodSource ?? (declaredPeriod ? "source" : "requested"),
    ...(declaredPeriod
      ? { declaredPeriod: { from: declaredPeriod.from, to: declaredPeriod.to } }
      : {}),
    ...(input.edition ? { edition: input.edition } : {}),
    chunks: [emptyChunk("masters", MASTERS_CHUNK_ID, { ...input.period })],
    updatedAt: input.updatedAt,
  }
}

export function createManifest(input: {
  sessionId: string
  company: string
  mode: "opening" | "closing"
  period: TallyDateRange
  updatedAt: string
  parts?: number
  periodSource?: TallyPeriodSource
  declaredPeriod?: TallyDateRange
  edition?: TallyEdition
  companySource?: "file" | "operator"
}): TallyMigrationManifest {
  const open = createOpenManifest(input)
  const ranges = splitPeriod(input.period, input.parts ?? 1)
  return {
    ...open,
    chunks: [
      ...open.chunks,
      ...ranges.map((range) => emptyChunk("vouchers", voucherChunkId(range), range)),
    ],
  }
}

/**
 * Adds a chunk the manifest does not have yet. A file re-uploaded for a range
 * already staged leaves the existing entry in place, so a retry cannot leave
 * two chunks claiming the same range.
 */
export function ensureChunk(
  manifest: TallyMigrationManifest,
  input: { kind: TallyChunkKind; id: string; range: TallyDateRange },
  now = new Date().toISOString(),
): TallyMigrationManifest {
  if (manifest.chunks.some((chunk) => chunk.id === input.id)) return manifest
  rangeEnd(input.range)
  return {
    ...manifest,
    chunks: [...manifest.chunks, emptyChunk(input.kind, input.id, { ...input.range })],
    updatedAt: now,
  }
}

/**
 * Grows the promised period to cover a range staged later in the same session.
 * Files may arrive in any order, so the period is the union of everything
 * uploaded rather than the range of whichever file happened to come first.
 * A narrower period never shrinks it.
 */
export function widenPeriod(
  manifest: TallyMigrationManifest,
  range: TallyDateRange,
  now = new Date().toISOString(),
  kind?: "masters" | "vouchers",
): TallyMigrationManifest {
  // A masters export is undated: the range its file name carries is the span
  // Tally was asked for. The day books are what actually cover a period, so
  // once one exists the promised period is the union of their ranges.
  const voucherChunks = manifest.chunks.filter((chunk) => chunk.kind === "vouchers")
  let start: number
  let end: number
  if (kind === "masters" && voucherChunks.length > 0) {
    start = Math.min(...voucherChunks.map((chunk) => rangeStart(chunk.range)))
    end = Math.max(...voucherChunks.map((chunk) => rangeEnd(chunk.range)))
  } else if (kind === "vouchers") {
    const ranges = [...voucherChunks.map((chunk) => chunk.range), range]
    start = Math.min(...ranges.map(rangeStart))
    end = Math.max(...ranges.map(rangeEnd))
  } else {
    start = Math.min(rangeStart(manifest.period), rangeStart(range))
    end = Math.max(rangeEnd(manifest.period), rangeEnd(range))
  }
  const period = { from: formatIsoDate(start), to: formatIsoDate(end) }
  if (sameRange(period, manifest.period)) return manifest
  return {
    ...manifest,
    period,
    chunks: manifest.chunks.map((chunk) =>
      chunk.kind === "masters" ? { ...chunk, range: { ...period } } : chunk,
    ),
    updatedAt: now,
  }
}

function problem(code: string, message: string): TallyManifestProblem {
  return { code, message }
}

/**
 * Everything that makes a manifest unsafe to apply. An empty list means the
 * session covers its whole period exactly once with no unfinished range and no
 * count that contradicted the source.
 *
 * Incompleteness is a problem; unverifiability is not. A migration with no
 * independent source count can still be applied — it simply never claims to be
 * verified. Use `manifestUnverified` for that disclosure.
 */
export function manifestProblems(manifest: TallyMigrationManifest): TallyManifestProblem[] {
  const problems: TallyManifestProblem[] = []

  if (manifest.version !== TALLY_MANIFEST_VERSION) {
    problems.push(problem("TALLY_MANIFEST_VERSION", "This migration manifest was written by a different version of the importer. Run the preview again."))
  }
  if (!manifest.sessionId.trim()) {
    problems.push(problem("TALLY_MANIFEST_SESSION", "The migration manifest names no session."))
  }
  if (!manifest.company.trim()) {
    problems.push(problem("TALLY_MANIFEST_COMPANY", "The migration manifest names no company, so it cannot be matched against the export."))
  }
  if (manifest.periodSource !== "source" && manifest.periodSource !== "requested") {
    problems.push(problem("TALLY_PERIOD_SOURCE", "The migration manifest does not say where its period came from."))
  }

  const masters = manifest.chunks.filter((chunk) => chunk.kind === "masters")
  if (masters.length === 0) {
    problems.push(problem("TALLY_MASTERS_MISSING", "The masters have not been read for this migration."))
  }
  if (masters.length > 1) {
    problems.push(problem("TALLY_MASTERS_DUPLICATE", "More than one masters chunk belongs to this migration."))
  }

  const seen = new Set<string>()
  for (const chunk of manifest.chunks) {
    if (seen.has(chunk.id)) {
      problems.push(problem("TALLY_CHUNK_DUPLICATE_ID", `Chunk ${chunk.id} appears more than once.`))
    }
    seen.add(chunk.id)
  }

  let periodStart: number
  let periodEnd: number
  try {
    periodStart = rangeStart(manifest.period)
    periodEnd = rangeEnd(manifest.period)
  } catch {
    problems.push(problem("TALLY_PERIOD_INVALID", "The migration period is not a valid date range."))
    return problems
  }

  for (const chunk of manifest.chunks) {
    let start: number
    let end: number
    try {
      start = rangeStart(chunk.range)
      end = rangeEnd(chunk.range)
    } catch {
      problems.push(problem("TALLY_CHUNK_RANGE_INVALID", `Chunk ${chunk.id} has an invalid date range.`))
      continue
    }
    if (start < periodStart || end > periodEnd) {
      problems.push(problem("TALLY_CHUNK_OUT_OF_RANGE", `Chunk ${chunk.id} falls outside the migration period.`))
    }
    for (const date of [chunk.firstDate, chunk.lastDate]) {
      if (!date) continue
      let at: number
      try {
        at = parseTallyIsoDate(date)
      } catch {
        problems.push(problem("TALLY_CHUNK_DATES_INVALID", `Chunk ${chunk.id} records a date that is not a calendar day.`))
        continue
      }
      if (at < start || at > end) {
        problems.push(problem("TALLY_CHUNK_DATES_OUTSIDE", `Chunk ${chunk.id} holds a voucher dated outside its own range.`))
      }
    }
  }

  for (const chunk of manifest.chunks) {
    if (chunk.status === "failed") {
      const detail = chunk.error ? `: ${chunk.error}` : "."
      problems.push(problem("TALLY_CHUNK_FAILED", `Chunk ${chunk.id} did not finish${detail}`))
    } else if (chunk.status !== "complete") {
      problems.push(problem("TALLY_CHUNK_INCOMPLETE", `Chunk ${chunk.id} has not been read yet or is still running.`))
    }
    if (chunk.reconciliation === "mismatch") {
      problems.push(
        problem(
          "TALLY_CHUNK_MISMATCH",
          `Chunk ${chunk.id} reported ${chunk.expectedRecords} records but ${chunk.recordsRead} were read.`,
        ),
      )
    }
  }

  const ranges = manifest.chunks
    .filter((chunk) => chunk.kind === "vouchers")
    .map((chunk) => chunk.range)
    .sort((left, right) => rangeStart(left) - rangeStart(right) || rangeEnd(left) - rangeEnd(right))

  if (ranges.length === 0) {
    problems.push(problem("TALLY_CHUNK_MISSING", "No voucher range belongs to this migration."))
  } else {
    const first = ranges[0]
    const last = ranges[ranges.length - 1]
    if (first && rangeStart(first) !== periodStart) {
      problems.push(problem("TALLY_CHUNK_GAP", "The first voucher range does not start at the beginning of the period."))
    }
    if (last && rangeEnd(last) !== periodEnd) {
      problems.push(problem("TALLY_CHUNK_GAP", "The last voucher range does not end at the end of the period."))
    }
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]
      const current = ranges[index]
      if (!previous || !current) continue
      if (rangeStart(current) <= rangeEnd(previous)) {
        problems.push(problem("TALLY_CHUNK_OVERLAP", "Two voucher ranges cover the same dates."))
      } else if (rangeStart(current) > nextDay(rangeEnd(previous))) {
        problems.push(problem("TALLY_CHUNK_GAP", "A stretch of the period is not covered by any voucher range."))
      }
    }
  }

  return problems
}

/**
 * Chunks whose completeness no independent count corroborates. This is not a
 * refusal: it is the reason Apply must not report the migration as verified.
 */
export function manifestUnverified(manifest: TallyMigrationManifest): TallyManifestProblem[] {
  return manifest.chunks
    .filter((chunk) => chunk.status === "complete" && chunk.reconciliation === "unverified")
    .map((chunk) =>
      problem(
        "TALLY_CHUNK_UNVERIFIED",
        `Chunk ${chunk.id} was read without an independent source count, so its completeness is unverified.`,
      ),
    )
}

export function canApplyManifest(manifest: TallyMigrationManifest): {
  ok: boolean
  problems: TallyManifestProblem[]
  unverified: TallyManifestProblem[]
} {
  const problems = manifestProblems(manifest)
  return { ok: problems.length === 0, problems, unverified: manifestUnverified(manifest) }
}

/** Every voucher must fall inside the period its export declares. */
export function voucherDatesOutsidePeriod(
  dates: Array<string | undefined>,
  period: TallyDateRange,
): string[] {
  const start = rangeStart(period)
  const end = rangeEnd(period)
  const outside = new Set<string>()
  for (const date of dates) {
    if (!date) continue
    let at: number
    try {
      at = parseTallyIsoDate(date)
    } catch {
      outside.add(date)
      continue
    }
    if (at < start || at > end) outside.add(date)
  }
  return [...outside].sort()
}

/** Earliest and latest readable date, ignoring empty ones. */
export function dateSpan(dates: Array<string | undefined>): {
  firstDate?: TallyIsoDate
  lastDate?: TallyIsoDate
} {
  let first: string | undefined
  let last: string | undefined
  for (const date of dates) {
    if (!date) continue
    try {
      parseTallyIsoDate(date)
    } catch {
      continue
    }
    if (first === undefined || date < first) first = date
    if (last === undefined || date > last) last = date
  }
  return {
    ...(first === undefined ? {} : { firstDate: first }),
    ...(last === undefined ? {} : { lastDate: last }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRangeLike(value: unknown): value is TallyDateRange {
  return isRecord(value) && typeof value.from === "string" && typeof value.to === "string"
}

const STATUSES: TallyChunkStatus[] = ["pending", "running", "complete", "failed"]
const RECONCILIATIONS: TallyReconciliation[] = ["verified", "unverified", "mismatch"]

/**
 * Shape guard for a manifest read back from the session. A malformed one must
 * be refused, not passed to the validators, which assume these fields exist.
 */
export function isManifestLike(value: unknown): value is TallyMigrationManifest {
  if (!isRecord(value)) return false
  if (typeof value.version !== "number") return false
  if (typeof value.sessionId !== "string") return false
  if (typeof value.company !== "string") return false
  if (value.mode !== "opening" && value.mode !== "closing") return false
  if (!isRangeLike(value.period)) return false
  if (value.periodSource !== "source" && value.periodSource !== "requested") return false
  if (value.declaredPeriod !== undefined && !isRangeLike(value.declaredPeriod)) return false
  if (
    value.edition !== undefined &&
    value.edition !== "prime" &&
    value.edition !== "erp9" &&
    value.edition !== "unknown"
  ) {
    return false
  }
  if (typeof value.updatedAt !== "string") return false
  if (!Array.isArray(value.chunks)) return false
  return value.chunks.every(
    (chunk) =>
      isRecord(chunk) &&
      typeof chunk.id === "string" &&
      (chunk.kind === "masters" || chunk.kind === "vouchers") &&
      STATUSES.includes(chunk.status as TallyChunkStatus) &&
      isRangeLike(chunk.range) &&
      typeof chunk.attempts === "number" &&
      (chunk.extractedRecords === undefined || typeof chunk.extractedRecords === "number") &&
      typeof chunk.recordsRead === "number" &&
      RECONCILIATIONS.includes(chunk.reconciliation as TallyReconciliation) &&
      typeof chunk.bytes === "number",
  )
}

/**
 * Records one attempt against a chunk. The entry is replaced in place, so a
 * retry never adds a second copy of the same range. Replaying a completed
 * result changes nothing.
 */
export function recordChunkResult(
  manifest: TallyMigrationManifest,
  chunkId: string,
  result: TallyChunkResult,
  now = new Date().toISOString(),
): TallyMigrationManifest {
  const index = manifest.chunks.findIndex((chunk) => chunk.id === chunkId)
  const existing = manifest.chunks[index]
  if (index < 0 || !existing) throw new Error("TALLY_CHUNK_UNKNOWN")

  // A completed chunk is final for this manifest: a late retry, a duplicate
  // response or a second tab must not demote it back to running or failed.
  if (existing.status === "complete") return manifest

  const terminal = result.status !== "running"
  const attempts =
    result.status === "running" || existing.status !== "running"
      ? existing.attempts + 1
      : existing.attempts

  const recordsRead = result.recordsRead ?? existing.recordsRead
  const expectedRecords = result.expectedRecords ?? existing.expectedRecords
  const next: TallyMigrationChunk = {
    ...existing,
    status: result.status,
    attempts,
    extractedRecords: result.extractedRecords ?? existing.extractedRecords,
    recordsRead,
    expectedRecords,
    firstDate: result.firstDate ?? existing.firstDate,
    lastDate: result.lastDate ?? existing.lastDate,
    reconciliation: reconcileCounts(recordsRead, expectedRecords),
    bytes: result.bytes ?? existing.bytes,
    checksum: result.checksum ?? existing.checksum,
    startedAt: existing.startedAt ?? now,
    finishedAt: terminal ? now : undefined,
    error: result.status === "failed" ? (result.error ?? "TALLY_CHUNK_FAILED") : undefined,
  }

  return {
    ...manifest,
    chunks: manifest.chunks.map((chunk, at) => (at === index ? next : chunk)),
    updatedAt: now,
  }
}

/**
 * Records a result for a chunk the operator explicitly uploaded again. Unlike
 * `recordChunkResult`, a completed chunk is replaced rather than left alone:
 * the new file stands in for the one already staged. Attempts and the first
 * start time carry over, so a corrected slice still shows it was tried before.
 */
export function replaceChunkResult(
  manifest: TallyMigrationManifest,
  chunkId: string,
  result: TallyChunkResult,
  now = new Date().toISOString(),
): TallyMigrationManifest {
  const existing = manifest.chunks.find((chunk) => chunk.id === chunkId)
  if (!existing) throw new Error("TALLY_CHUNK_UNKNOWN")

  const reset: TallyMigrationManifest = {
    ...manifest,
    chunks: manifest.chunks.map((chunk) =>
      chunk.id === chunkId
        ? {
            ...emptyChunk(chunk.kind, chunk.id, { ...chunk.range }),
            attempts: chunk.attempts,
            ...(chunk.startedAt ? { startedAt: chunk.startedAt } : {}),
          }
        : chunk,
    ),
  }
  return recordChunkResult(reset, chunkId, result, now)
}

function executionOrder(manifest: TallyMigrationManifest): TallyMigrationChunk[] {
  const masters = manifest.chunks.filter((chunk) => chunk.kind === "masters")
  const vouchers = manifest.chunks
    .filter((chunk) => chunk.kind === "vouchers")
    .sort((left, right) => rangeStart(left.range) - rangeStart(right.range))
  return [...masters, ...vouchers]
}

/** Masters first, then the earliest unfinished range — including one to retry. */
export function nextChunkToRun(
  manifest: TallyMigrationManifest,
): TallyMigrationChunk | undefined {
  return executionOrder(manifest).find((chunk) => chunk.status !== "complete")
}

/**
 * Halves a range. A single day cannot be halved, so a response that is still
 * too large on one day is a failure rather than a silent truncation.
 */
export function halveRange(range: TallyDateRange): [TallyDateRange, TallyDateRange] {
  const start = rangeStart(range)
  const end = rangeEnd(range)
  if (end === start) throw new Error("TALLY_CHUNK_RANGE_MINIMAL")
  const days = Math.round((end - start) / DAY_MS) + 1
  const middle = start + (Math.ceil(days / 2) - 1) * DAY_MS
  return [
    { from: range.from, to: formatIsoDate(middle) },
    { from: formatIsoDate(middle + DAY_MS), to: range.to },
  ]
}

/**
 * Replaces one voucher chunk with the ranges it is retried as. The original id
 * disappears, so a resume cannot retry the oversized range as well as its two
 * halves; the halves are ordinary pending chunks and carry the same contract.
 */
export function splitChunk(
  manifest: TallyMigrationManifest,
  chunkId: string,
  ranges: TallyDateRange[],
): TallyMigrationManifest {
  const index = manifest.chunks.findIndex((chunk) => chunk.id === chunkId)
  const existing = manifest.chunks[index]
  if (index < 0 || !existing) throw new Error("TALLY_CHUNK_UNKNOWN")
  if (existing.kind !== "vouchers") throw new Error("TALLY_CHUNK_NOT_SPLITTABLE")
  if (ranges.length < 2) throw new Error("TALLY_CHUNK_SPLIT_TOO_SMALL")

  const seen = new Set<string>()
  for (const range of ranges) {
    rangeEnd(range)
    const id = voucherChunkId(range)
    if (seen.has(id) || manifest.chunks.some((chunk, at) => at !== index && chunk.id === id)) {
      throw new Error("TALLY_CHUNK_DUPLICATE_ID")
    }
    seen.add(id)
  }

  const replacement = ranges.map((range) =>
    emptyChunk("vouchers", voucherChunkId(range), {
      from: range.from,
      to: range.to,
    }),
  )
  replacement.sort((left, right) => rangeStart(left.range) - rangeStart(right.range))

  return {
    ...manifest,
    chunks: [
      ...manifest.chunks.slice(0, index),
      ...replacement,
      ...manifest.chunks.slice(index + 1),
    ],
    updatedAt: new Date().toISOString(),
  }
}

/** Whether a chunk may be attempted again without operator intervention. */
export function canRetryChunk(chunk: TallyMigrationChunk, maxAttempts: number): boolean {
  return chunk.status === "failed" && chunk.attempts < maxAttempts
}

export type TallyExtractionSummary = {
  totalChunks: number
  complete: number
  failed: number
  pending: number
  attempts: number
  recordsRead: number
  recordsExtracted: number | null
  /** Dates covered by complete voucher chunks, not by the promised period. */
  coveredFrom?: TallyIsoDate
  coveredTo?: TallyIsoDate
  /** Gaps between complete voucher ranges, as inclusive day counts. */
  gaps: Array<{ after: TallyIsoDate; before: TallyIsoDate }>
  failures: Array<{ id: string; error?: string; attempts: number }>
  completeAll: boolean
}

/**
 * What the operator sees while and after extraction. Coverage is derived from
 * complete chunks only, so a failed chunk leaves a visible gap instead of a
 * period that merely claims to be covered.
 */
export function summariseExtraction(manifest: TallyMigrationManifest): TallyExtractionSummary {
  const chunks = manifest.chunks
  const completed = chunks.filter((chunk) => chunk.status === "complete")
  const failed = chunks.filter((chunk) => chunk.status === "failed")
  const pending = chunks.filter((chunk) => chunk.status !== "complete" && chunk.status !== "failed")

  const voucherRanges = completed
    .filter((chunk) => chunk.kind === "vouchers")
    .map((chunk) => chunk.range)
    .sort((left, right) => rangeStart(left) - rangeStart(right) || rangeEnd(left) - rangeEnd(right))

  const gaps: TallyExtractionSummary["gaps"] = []
  for (let index = 1; index < voucherRanges.length; index += 1) {
    const previous = voucherRanges[index - 1]
    const current = voucherRanges[index]
    if (!previous || !current) continue
    if (rangeStart(current) > nextDay(rangeEnd(previous))) {
      gaps.push({ after: previous.to, before: current.from })
    }
  }

  return {
    totalChunks: chunks.length,
    complete: completed.length,
    failed: failed.length,
    pending: pending.length,
    attempts: chunks.reduce((total, chunk) => total + chunk.attempts, 0),
    recordsRead: completed.reduce((total, chunk) => total + chunk.recordsRead, 0),
    recordsExtracted: completed.some((chunk) => chunk.extractedRecords !== undefined)
      ? completed.reduce((total, chunk) => total + (chunk.extractedRecords ?? 0), 0)
      : null,
    ...(voucherRanges[0] ? { coveredFrom: voucherRanges[0].from } : {}),
    ...(voucherRanges[voucherRanges.length - 1]
      ? { coveredTo: voucherRanges[voucherRanges.length - 1]!.to }
      : {}),
    gaps,
    failures: failed.map((chunk) => ({
      id: chunk.id,
      attempts: chunk.attempts,
      ...(chunk.error ? { error: chunk.error } : {}),
    })),
    completeAll: chunks.length > 0 && chunks.every((chunk) => chunk.status === "complete"),
  }
}
