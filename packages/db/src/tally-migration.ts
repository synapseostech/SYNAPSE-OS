import { TallyXmlAdapter } from "./tally-xml"

/** Safe, provider-neutral staging boundary for Tally and other exports. */
export type MigrationFormat = "tally-xml" | "tally-json" | "xlsx" | "csv"
export type MigrationObjectType = "company" | "master" | "inventory" | "transaction" | "accounting"

export type MigrationDiscovery = {
  format: MigrationFormat
  company?: string
  currency?: string
  financialPeriod?: { from?: string; to?: string }
  counts: Partial<Record<string, number>>
  warnings: string[]
}

export type MigrationSourceAdapter = {
  readonly format: MigrationFormat
  analyse(input: Uint8Array, fileName: string, mimeType?: string): MigrationDiscovery
}

const MAX_BYTES = 25 * 1024 * 1024
const FORMULA = /^[=+\-@]/

function assertUpload(input: Uint8Array, fileName: string): void {
  if (input.byteLength > MAX_BYTES) throw new Error("MIGRATION_FILE_TOO_LARGE")
  if (!fileName.trim() || /[\0\r\n]/.test(fileName)) throw new Error("MIGRATION_INVALID_FILENAME")
}

function safeText(input: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(input)
}

export class TallySpreadsheetAdapter implements MigrationSourceAdapter {
  readonly format = "csv" as const
  analyse(input: Uint8Array, fileName: string): MigrationDiscovery {
    assertUpload(input, fileName)
    const text = safeText(input)
    const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 10001)
    const warnings: string[] = []
    if (rows.length > 10000) warnings.push("ROW_LIMIT_TRUNCATED")
    const cells = rows.flatMap((row) => row.split(",").map((cell) => cell.trim()))
    if (cells.some((cell) => FORMULA.test(cell))) warnings.push("FORMULA_CELL_NEUTRALISED")
    return {
      format: "csv",
      counts: { rows: Math.max(0, rows.length - 1), columns: rows[0]?.split(",").length ?? 0 },
      warnings,
    }
  }
}

export class TallyJsonAdapter implements MigrationSourceAdapter {
  readonly format = "tally-json" as const
  analyse(input: Uint8Array, fileName: string): MigrationDiscovery {
    assertUpload(input, fileName)
    const value = JSON.parse(safeText(input)) as Record<string, unknown>
    const rows = Array.isArray(value.data) ? value.data.length : Array.isArray(value.rows) ? value.rows.length : 0
    return {
      format: "tally-json",
      company: typeof value.company === "string" ? value.company : undefined,
      currency: typeof value.currency === "string" ? value.currency : undefined,
      counts: { rows },
      warnings: rows ? [] : ["NO_TABULAR_ROWS_DISCOVERED"],
    }
  }
}

export function adapterFor(fileName: string, mimeType = ""): MigrationSourceAdapter {
  const lower = fileName.toLowerCase()
  // XML is checked before JSON because `application/xml` does not contain
  // "json", and `.xml` files can legitimately be served as `text/xml`.
  if (lower.endsWith(".xml") || mimeType.includes("xml")) return new TallyXmlAdapter()
  if (lower.endsWith(".json") || mimeType.includes("json")) return new TallyJsonAdapter()
  if (lower.endsWith(".csv") || mimeType.includes("csv")) return new TallySpreadsheetAdapter()
  throw new Error("MIGRATION_UNSUPPORTED_FILE_TYPE")
}
