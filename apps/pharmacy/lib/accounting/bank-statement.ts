import Papa from "papaparse"
import { mapBankStatementRecords } from "@synapse/db/accounting-bank-statement"

export type { BankStatementRow } from "@synapse/db/accounting-bank-statement"
export { exactBankCandidates } from "@synapse/db/accounting-bank-statement"

/**
 * Reads the file with PapaParse; the column mapping is shared with the mobile
 * API through `@synapse/db`.
 */
export function parseBankStatementCsv(csv: string, defaultCurrency: string) {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  })
  if (parsed.errors.length > 0) {
    throw new Error(`CSV could not be parsed: ${parsed.errors[0].message}`)
  }

  const headers = parsed.meta.fields ?? []
  const records = parsed.data.map((row, index) => ({
    lineNumber: index + 2,
    values: headers.map((header) => row[header] ?? ""),
  }))
  return mapBankStatementRecords(headers, records, defaultCurrency)
}
