/**
 * Reading a zipped Tally export package into per-file results.
 *
 * A package holds one XML export per month and the manifest the exporter wrote
 * beside them. This module unpacks it one entry at a time, parses each export,
 * and compares what the parser found against what the manifest claims — which
 * is the only independent count the customer's data carries. Agreement proves
 * the pipeline carried every record the exporter wrote; it does not prove Tally
 * returned every record it holds. The report says which of those two it proves.
 *
 * Entries are handled one at a time and released, because inflating all
 * thirteen months at once costs more memory than the machine running the
 * import has to spare. Callers receive each document through `onDocument`
 * rather than getting them collected.
 */

import { createHash } from "node:crypto"

import { parseTallyXmlRows, type TallyXmlDocument, type TallyXmlRowWarning } from "./tally-xml-rows"
import {
  extractTallyZipEntry,
  readTallyZipDirectory,
  TallyZipError,
  type TallyZipEntry,
} from "./tally-zip"

export type TallyArchiveRole = "export" | "manifest" | "summary" | "ignored"

/**
 * The company a package's summary names, when one does. Read from the exporter's
 * own text rather than inferred: an export that omits the company can still be
 * staged under the one its package declares, and the operator can see where the
 * name came from.
 */
export type TallyArchiveCompany = {
  name: string
  /** The entry the line was read from. */
  source: string
}

/** One row the exporter's manifest declares. */
export type TallyManifestRow = {
  month: string
  status: string
  vouchers: number | null
  firstDate: string | null
  lastDate: string | null
  fileName: string
  bytes: number | null
  error: string
}

export type TallyArchiveFile = {
  name: string
  role: TallyArchiveRole
  bytes: number
  sha256: string
  /** Present for exports that parsed, and for any entry that failed. */
  vouchers: number | null
  inventoryLines: number | null
  batchAllocations: number | null
  firstDate: string | null
  lastDate: string | null
  firstEffectiveDate: string | null
  lastEffectiveDate: string | null
  warnings: TallyXmlRowWarning[]
  /** Text the parser had to rewrite to store it; zero means byte-for-byte. */
  controlCharactersStripped: number
  /** Set when the entry could not be read; the entry is not usable. */
  failure: { code: string; message: string } | null
  /** The manifest row this export was matched to, by file name. */
  manifest: TallyManifestRow | null
  /** Differences between the manifest row and what the parser found. */
  discrepancies: string[]
}

export type TallyArchiveReconciliation = {
  /**
   * `verified` — every manifest row has a file whose counts and dates agree.
   * `unverified` — the package carries no manifest, so nothing independent
   *   confirms the set is complete.
   * `mismatch` — at least one file disagrees with the manifest.
   * `failed` — an entry could not be read at all.
   */
  status: "verified" | "unverified" | "mismatch" | "failed"
  manifestVouchers: number | null
  parsedVouchers: number
  /** Source text the parser rewrote to make it storable, across every file. */
  controlCharactersStripped: number
  manifestFiles: number
  exportFiles: number
  unmatchedManifestRows: string[]
  /** Manifest rows whose file is absent from the package. */
  missingFiles: string[]
  /** Exports the manifest does not mention. */
  undeclaredFiles: string[]
  problems: string[]
}

export type TallyArchiveReport = {
  files: TallyArchiveFile[]
  reconciliation: TallyArchiveReconciliation
  /** The company the package's summary names, when it names one. */
  company: TallyArchiveCompany | null
  /** Entries that are neither an export, a manifest, nor a summary. */
  ignored: string[]
  totalBytes: number
}

export type TallyArchiveOptions = {
  /**
   * Called once per parsed export, in archive order. `extracted` is the entry's
   * own bytes, so a caller can stage the file it was given rather than
   * re-inflate the package.
   */
  onDocument?: (
    document: TallyXmlDocument,
    file: TallyArchiveFile,
    extracted: Uint8Array,
  ) => void | Promise<void>
  /** Total entries, entries or bytes beyond these are refused earlier. */
  maxFiles?: number
}

export class TallyArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "TallyArchiveError"
  }
}

/**
 * The `Company:` line an exporter writes into its summary. Anchored to the
 * start of a line so a sentence that happens to mention a company is not read
 * as the declaration.
 */
function companyFromSummary(text: string, source: string): TallyArchiveCompany | null {
  const match = /^[ \t]*Company[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(text)
  const name = match?.[1]?.trim()
  if (!name) return null
  return { name: name.slice(0, 200), source }
}

/**
 * The company a package declares, read without inflating its exports. Staging
 * needs the name before it starts so each entry can be checked against it;
 * reading only the manifest and summary entries keeps that cheap.
 */
export function readTallyPackageCompany(bytes: Uint8Array): TallyArchiveCompany | null {
  const archive = readTallyZipDirectory(bytes)
  for (const entry of archive.entries) {
    const lower = entry.name.toLowerCase()
    if (!lower.endsWith(".csv") && !lower.endsWith(".txt")) continue
    const extracted = safeExtract(bytes, entry)
    if (!extracted) continue
    const company = companyFromSummary(decodeText(extracted), entry.name)
    if (company) return company
  }
  return null
}

/** RFC 4180 fields, enough for the manifest's comma-and-quotes layout. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ",") {
      fields.push(field)
      field = ""
    } else {
      field += char
    }
  }
  fields.push(field)
  return fields
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function isoFromDashed(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

/**
 * The manifest the exporter wrote. Columns are found by header rather than by
 * position, because the exporter has already changed the layout once.
 */
export function parseTallyArchiveManifest(text: string): TallyManifestRow[] {
  const withoutBom = text.replace(/^﻿/, "")
  const lines = withoutBom.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return []
  const header = parseCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
  const column = (name: string) => header.indexOf(name)
  const monthAt = column("month")
  const statusAt = column("status")
  const vouchersAt = column("vouchers")
  const firstAt = column("earliestvoucherdate")
  const lastAt = column("latestvoucherdate")
  const fileAt = column("file")
  const bytesAt = column("bytes")
  const errorAt = column("error")
  if (fileAt < 0) return []

  const rows: TallyManifestRow[] = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const fileName = (cells[fileAt] ?? "").trim()
    if (!fileName) continue
    rows.push({
      month: monthAt >= 0 ? (cells[monthAt] ?? "").trim() : "",
      status: statusAt >= 0 ? (cells[statusAt] ?? "").trim() : "",
      vouchers: vouchersAt >= 0 ? toNumber(cells[vouchersAt]) : null,
      firstDate: firstAt >= 0 ? isoFromDashed(cells[firstAt]) : null,
      lastDate: lastAt >= 0 ? isoFromDashed(cells[lastAt]) : null,
      fileName,
      bytes: bytesAt >= 0 ? toNumber(cells[bytesAt]) : null,
      error: errorAt >= 0 ? (cells[errorAt] ?? "").trim() : "",
    })
  }
  return rows
}

function roleOf(name: string, text?: string): TallyArchiveRole {
  const lower = name.toLowerCase()
  if (lower.endsWith(".xml")) return "export"
  if (lower.endsWith(".csv") && /manifest/.test(lower)) return "manifest"
  if (lower.endsWith(".txt")) return "summary"
  // A manifest is sometimes renamed; its header is the reliable signal.
  if (text && /(^|\n)\s*"?month"?\s*,\s*"?status"?/i.test(text) && /vouchers/i.test(text)) {
    return "manifest"
  }
  return "ignored"
}

function datesOf(document: TallyXmlDocument): {
  first: string | null
  last: string | null
  firstEffective: string | null
  lastEffective: string | null
} {
  const dates: string[] = []
  const effective: string[] = []
  for (const voucher of document.vouchers) {
    if (voucher.date) dates.push(voucher.date)
    if (voucher.effectiveDate) effective.push(voucher.effectiveDate)
  }
  dates.sort()
  effective.sort()
  return {
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    firstEffective: effective[0] ?? null,
    lastEffective: effective[effective.length - 1] ?? null,
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

/**
 * Reads a package entry by entry. Every entry is reported, including the ones
 * that could not be read: an operator needs to know which file failed and why
 * far more than they need the whole upload refused.
 */
export async function readTallyArchive(
  bytes: Uint8Array,
  options: TallyArchiveOptions = {},
): Promise<TallyArchiveReport> {
  let archive
  try {
    archive = readTallyZipDirectory(bytes)
  } catch (error) {
    if (error instanceof TallyZipError) throw new TallyArchiveError(error.code, error.message)
    throw error
  }

  const maxFiles = options.maxFiles ?? 64
  if (archive.entries.length > maxFiles) {
    throw new TallyArchiveError(
      "TALLY_ARCHIVE_TOO_MANY_FILES",
      `The package holds ${archive.entries.length} files. The limit is ${maxFiles}.`,
    )
  }

  const files: TallyArchiveFile[] = []
  const ignored: string[] = []
  const manifestRows: TallyManifestRow[] = []
  const manifestTexts: string[] = []
  let archiveCompany: TallyArchiveCompany | null = null

  // First pass: read the manifest, so exports can be matched while they stream.
  for (const entry of archive.entries) {
    if (!entry.name.toLowerCase().endsWith(".csv") && !entry.name.toLowerCase().endsWith(".txt")) {
      continue
    }
    const extracted = safeExtract(bytes, entry)
    if (!extracted) continue
    const text = decodeText(extracted)
    if (roleOf(entry.name, text) === "manifest") {
      manifestTexts.push(entry.name)
      manifestRows.push(...parseTallyArchiveManifest(text))
    } else if (!archiveCompany) {
      // Every export in one package is the same company, so the first summary
      // that names it settles the name for the whole package.
      archiveCompany = companyFromSummary(text, entry.name)
    }
  }

  const byFileName = new Map<string, TallyManifestRow>()
  for (const row of manifestRows) {
    const key = row.fileName.toLowerCase()
    if (!byFileName.has(key)) byFileName.set(key, row)
  }

  for (const entry of archive.entries) {
    const isCsvOrText = entry.name.toLowerCase().endsWith(".csv") || entry.name.toLowerCase().endsWith(".txt")
    if (isCsvOrText && manifestTexts.includes(entry.name)) {
      const extracted = safeExtract(bytes, entry)
      files.push({
        name: entry.name,
        role: "manifest",
        bytes: entry.uncompressedBytes,
        sha256: sha256(extracted ?? new Uint8Array()),
        vouchers: null,
        inventoryLines: null,
        batchAllocations: null,
        firstDate: null,
        lastDate: null,
        firstEffectiveDate: null,
        lastEffectiveDate: null,
        warnings: [],
        controlCharactersStripped: 0,
        failure: extracted ? null : { code: "TALLY_ZIP_CORRUPT", message: "The manifest could not be read." },
        manifest: null,
        discrepancies: [],
      })
      continue
    }

    if (isCsvOrText) {
      const extracted = safeExtract(bytes, entry)
      files.push({
        name: entry.name,
        role: "summary",
        bytes: entry.uncompressedBytes,
        sha256: sha256(extracted ?? new Uint8Array()),
        vouchers: null,
        inventoryLines: null,
        batchAllocations: null,
        firstDate: null,
        lastDate: null,
        firstEffectiveDate: null,
        lastEffectiveDate: null,
        warnings: [],
        controlCharactersStripped: 0,
        failure: null,
        manifest: null,
        discrepancies: [],
      })
      continue
    }

    if (roleOf(entry.name) === "ignored") {
      ignored.push(entry.name)
      files.push({
        name: entry.name,
        role: "ignored",
        bytes: entry.uncompressedBytes,
        sha256: "",
        vouchers: null,
        inventoryLines: null,
        batchAllocations: null,
        firstDate: null,
        lastDate: null,
        firstEffectiveDate: null,
        lastEffectiveDate: null,
        warnings: [],
        controlCharactersStripped: 0,
        failure: null,
        manifest: null,
        discrepancies: [],
      })
      continue
    }

    const extracted = safeExtract(bytes, entry)
    const manifest = byFileName.get(entry.name.toLowerCase()) ?? null
    if (!extracted) {
      files.push({
        name: entry.name,
        role: "export",
        bytes: entry.uncompressedBytes,
        sha256: "",
        vouchers: null,
        inventoryLines: null,
        batchAllocations: null,
        firstDate: null,
        lastDate: null,
        firstEffectiveDate: null,
        lastEffectiveDate: null,
        warnings: [],
        controlCharactersStripped: 0,
        failure: { code: "TALLY_ZIP_CORRUPT", message: "The entry could not be read." },
        manifest,
        discrepancies: [],
      })
      continue
    }

    let document: TallyXmlDocument
    try {
      document = parseTallyXmlRows(extracted, entry.name)
    } catch (error) {
      const code = (error as { message?: string }).message ?? "MIGRATION_XML_MALFORMED"
      files.push({
        name: entry.name,
        role: "export",
        bytes: entry.uncompressedBytes,
        sha256: sha256(extracted),
        vouchers: null,
        inventoryLines: null,
        batchAllocations: null,
        firstDate: null,
        lastDate: null,
        firstEffectiveDate: null,
        lastEffectiveDate: null,
        warnings: [],
        controlCharactersStripped: 0,
        failure: { code, message: describeParseFailure(code) },
        manifest,
        discrepancies: [],
      })
      continue
    }

    let inventoryLines = 0
    let batchAllocations = 0
    for (const voucher of document.vouchers) {
      for (const line of voucher.inventoryLines) {
        inventoryLines += 1
        batchAllocations += line.batches.length
      }
    }
    const dates = datesOf(document)
    const file: TallyArchiveFile = {
      name: entry.name,
      role: "export",
      bytes: entry.uncompressedBytes,
      sha256: sha256(extracted),
      vouchers: document.vouchers.length,
      inventoryLines,
      batchAllocations,
      firstDate: dates.first,
      lastDate: dates.last,
      firstEffectiveDate: dates.firstEffective,
      lastEffectiveDate: dates.lastEffective,
      warnings: document.warnings,
      controlCharactersStripped: document.stats?.controlCharactersStripped ?? 0,
      failure: null,
      manifest,
      discrepancies: discrepanciesFor(entry, document.vouchers.length, dates, manifest),
    }
    files.push(file)
    if (options.onDocument) await options.onDocument(document, file, extracted)
  }

  const reconciliation = reconcile(files, manifestRows)
  return {
    files,
    reconciliation,
    company: archiveCompany,
    ignored,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  }
}

function describeParseFailure(code: string): string {
  switch (code) {
    case "MIGRATION_XML_NOT_UTF8":
      return "The file is not UTF-8 text. Re-export it from Tally without changing its encoding."
    case "MIGRATION_XML_ENTITIES_REJECTED":
      return "The file declares a document type or entity, which is refused because it can expand without bound."
    case "MIGRATION_XML_TOO_COMPLEX":
      return "The file holds more tags than the parser reads in one pass."
    case "MIGRATION_FILE_TOO_LARGE":
      return "The file is larger than the parser accepts in one pass."
    case "MIGRATION_XML_INCOMPLETE":
      return "The file ends before its closing envelope, so it is truncated."
    case "MIGRATION_XML_STATUS_FAILED":
      return "Tally reported that the export failed. Re-run it in Tally and check the error it shows."
    default:
      return "The file is not a Tally XML export this importer can read."
  }
}

function discrepanciesFor(
  entry: TallyZipEntry,
  vouchers: number,
  dates: { first: string | null; last: string | null; firstEffective: string | null; lastEffective: string | null },
  manifest: TallyManifestRow | null,
): string[] {
  if (!manifest) return []
  const problems: string[] = []
  if (manifest.vouchers !== null && manifest.vouchers !== vouchers) {
    problems.push(
      `The manifest declares ${manifest.vouchers} vouchers but the file holds ${vouchers}.`,
    )
  }
  if (manifest.bytes !== null && manifest.bytes !== entry.uncompressedBytes) {
    problems.push(
      `The manifest declares ${manifest.bytes} bytes but the entry holds ${entry.uncompressedBytes}.`,
    )
  }
  if (manifest.firstDate && dates.first && manifest.firstDate !== dates.first) {
    problems.push(`The manifest declares the first voucher on ${manifest.firstDate}, the file says ${dates.first}.`)
  }
  if (manifest.lastDate && dates.last && manifest.lastDate !== dates.last) {
    problems.push(`The manifest declares the last voucher on ${manifest.lastDate}, the file says ${dates.last}.`)
  }
  if (manifest.status && manifest.status.toUpperCase() !== "SUCCESS") {
    problems.push(`The exporter recorded this month as ${manifest.status}.`)
  }
  if (manifest.error) problems.push(`The exporter recorded: ${manifest.error}`)
  return problems
}

function reconcile(
  files: TallyArchiveFile[],
  manifestRows: TallyManifestRow[],
): TallyArchiveReconciliation {
  const exports = files.filter((file) => file.role === "export")
  const parsedVouchers = exports.reduce((sum, file) => sum + (file.vouchers ?? 0), 0)
  const failed = exports.filter((file) => file.failure)
  const declaredNames = new Set(manifestRows.map((row) => row.fileName.toLowerCase()))
  const exportNames = new Set(exports.map((file) => file.name.toLowerCase()))

  const missingFiles = manifestRows
    .filter((row) => !exportNames.has(row.fileName.toLowerCase()))
    .map((row) => row.fileName)
  const undeclaredFiles = exports
    .filter((file) => !declaredNames.has(file.name.toLowerCase()))
    .map((file) => file.name)
  const unmatchedManifestRows = manifestRows
    .filter((row) => !exportNames.has(row.fileName.toLowerCase()))
    .map((row) => `${row.month || row.fileName}`)

  const problems: string[] = []
  for (const file of exports) {
    for (const problem of file.discrepancies) problems.push(`${file.name}: ${problem}`)
  }
  for (const name of missingFiles) problems.push(`The manifest lists ${name}, but the package does not hold it.`)
  for (const name of undeclaredFiles) problems.push(`${name} is in the package but not in the manifest.`)
  for (const file of failed) problems.push(`${file.name}: ${file.failure?.message ?? "unreadable"}`)

  let status: TallyArchiveReconciliation["status"]
  if (failed.length > 0) status = "failed"
  else if (manifestRows.length === 0) status = "unverified"
  else if (problems.length > 0) status = "mismatch"
  else status = "verified"

  const manifestVouchers = manifestRows.some((row) => row.vouchers !== null)
    ? manifestRows.reduce((sum, row) => sum + (row.vouchers ?? 0), 0)
    : null

  return {
    status,
    manifestVouchers,
    parsedVouchers,
    controlCharactersStripped: exports.reduce(
      (sum, file) => sum + file.controlCharactersStripped,
      0,
    ),
    manifestFiles: manifestRows.length,
    exportFiles: exports.length,
    unmatchedManifestRows,
    missingFiles,
    undeclaredFiles,
    problems,
  }
}

function safeExtract(bytes: Uint8Array, entry: TallyZipEntry): Uint8Array | null {
  try {
    return extractTallyZipEntry(bytes, entry)
  } catch {
    return null
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
