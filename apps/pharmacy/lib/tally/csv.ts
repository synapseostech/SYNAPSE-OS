/**
 * Flat CSV cut-over file: one row per record, discriminated by `record_type`.
 *
 * The same row shapes as the workbook so a pharmacy can export either format
 * from the same data. Unknown record types are rejected rather than skipped,
 * so a mistyped discriminator cannot silently drop vouchers.
 */

import Papa from "papaparse"
import { TallyTemplateError, TALLY_TABULAR_LIMITS, buildTallyDocument } from "./workbook"
import type { TallyTabularRecords, TallyRow } from "./workbook"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"

export const TALLY_CSV_RECORD_TYPES = [
  "meta",
  "account",
  "stock_item",
  "stock_batch",
  "voucher",
  "voucher_line",
  "stock_line",
  "bill",
] as const

export type TallyCsvRecordType = (typeof TALLY_CSV_RECORD_TYPES)[number]

const KEYS: Record<TallyCsvRecordType, keyof TallyTabularRecords> = {
  meta: "meta",
  account: "accounts",
  stock_item: "stockItems",
  stock_batch: "stockBatches",
  voucher: "vouchers",
  voucher_line: "voucherLines",
  stock_line: "stockLines",
  bill: "bills",
}

const RECORD_TYPE_SET = new Set<string>(TALLY_CSV_RECORD_TYPES)

/** Excel may leave a formula-neutralising quote on imported text. */
function unquote(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value
}

export function parseTallyCsv(text: string): TallyXmlDocument {
  if (!text.trim()) {
    throw new TallyTemplateError("CSV file is empty.", "TALLY_TEMPLATE_INVALID")
  }

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase().replace(/[\s-]+/g, "_"),
  })
  if (parsed.errors.length > 0) {
    throw new TallyTemplateError(
      `CSV could not be parsed: ${parsed.errors[0]?.message ?? "unknown error"}`,
      "TALLY_TEMPLATE_INVALID",
    )
  }

  const headers = parsed.meta.fields ?? []
  if (!headers.includes("record_type")) {
    throw new TallyTemplateError(
      "CSV is missing the record_type column.",
      "TALLY_TEMPLATE_INVALID",
    )
  }
  if (parsed.data.length > TALLY_TABULAR_LIMITS.MAX_ROWS) {
    throw new TallyTemplateError(
      `CSV has more than ${TALLY_TABULAR_LIMITS.MAX_ROWS} rows.`,
      "TALLY_TEMPLATE_TOO_LARGE",
    )
  }

  const records: TallyTabularRecords = {
    meta: [],
    accounts: [],
    stockItems: [],
    stockBatches: [],
    vouchers: [],
    voucherLines: [],
    stockLines: [],
    bills: [],
  }

  parsed.data.forEach((raw, index) => {
    const type = raw.record_type?.trim().toLowerCase() ?? ""
    if (!type) return
    if (!RECORD_TYPE_SET.has(type)) {
      throw new TallyTemplateError(
        `CSV row ${index + 2} has unknown record_type "${type}".`,
        "TALLY_TEMPLATE_INVALID",
      )
    }
    const row: TallyRow = {}
    for (const [key, value] of Object.entries(raw)) {
      if (key === "record_type" || value === undefined || value === null) continue
      const trimmed = unquote(String(value)).trim()
      if (!trimmed) continue
      row[key] = trimmed.slice(0, TALLY_TABULAR_LIMITS.MAX_TEXT)
    }
    records[KEYS[type as TallyCsvRecordType]].push(row)
  })

  return buildTallyDocument(records)
}
