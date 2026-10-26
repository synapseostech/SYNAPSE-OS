/**
 * Minimal RFC-4180 CSV reader.
 *
 * The previous importer split on "\n" and "," which corrupts any field that
 * contains a quoted comma or newline — common in patient addresses and notes.
 * This parser handles quoted fields, escaped quotes ("") and CRLF.
 *
 * Pure function, no I/O, so it can be unit tested without a database.
 */

export type CsvRow = { line: number; values: string[] }

export type CsvParseResult = {
  header: string[]
  rows: CsvRow[]
  /** Rows whose field count differs from the header. They are surfaced, never dropped silently. */
  malformed: CsvRow[]
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvError'
  }
}

/**
 * Parse CSV text into a header and data rows.
 *
 * @throws CsvError when the input is empty or has no header row.
 */
export function parseCsv(text: string, maxRows = 50_000): CsvParseResult {
  if (typeof text !== 'string' || text.length === 0) {
    throw new CsvError('File is empty')
  }

  const records: { line: number; values: string[] }[] = []
  let field = ''
  let values: string[] = []
  let inQuotes = false
  let line = 1
  let recordLine = 1

  const pushField = () => {
    values.push(field)
    field = ''
  }

  const pushRecord = () => {
    pushField()
    // Skip completely blank lines (trailing newline, stray blank row).
    if (values.length === 1 && values[0] === '') {
      values = []
      return
    }
    records.push({ line: recordLine, values })
    values = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        if (ch === '\n') line += 1
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      pushField()
      continue
    }
    if (ch === '\r') {
      continue
    }
    if (ch === '\n') {
      pushRecord()
      line += 1
      recordLine = line
      if (records.length > maxRows + 1) {
        throw new CsvError(`File exceeds the ${maxRows} row import limit`)
      }
      continue
    }
    field += ch
  }

  // Final record without trailing newline.
  if (field.length > 0 || values.length > 0) pushRecord()

  if (inQuotes) throw new CsvError('Unterminated quoted field')

  const [headerRecord, ...dataRecords] = records
  if (!headerRecord) throw new CsvError('File has no header row')

  const header = headerRecord.values.map((h) => h.trim())
  if (header.every((h) => h === '')) throw new CsvError('Header row is empty')

  const rows: CsvRow[] = []
  const malformed: CsvRow[] = []
  for (const record of dataRecords) {
    if (record.values.length === header.length) rows.push(record)
    else malformed.push(record)
  }

  return { header, rows, malformed }
}

/** Convert a parsed row into a header-keyed record. Extra/missing fields are ignored here. */
export function toRecord(header: string[], values: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < header.length; i += 1) {
    const key = header[i]
    if (!key) continue
    out[key] = (values[i] ?? '').trim()
  }
  return out
}
