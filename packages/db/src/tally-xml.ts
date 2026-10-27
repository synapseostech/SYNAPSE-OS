/**
 * Tally XML discovery adapter.
 *
 * TallyPrime's native export is XML, and until now `adapterFor()` rejected every
 * `.xml` upload even though `MigrationFormat` declared `"tally-xml"`. This closes
 * that gap without adding a general XML parser to the dependency tree.
 *
 * Safety, in order of importance:
 *
 *   1. Any document declaring a DOCTYPE or ENTITY is refused outright. That
 *      removes XXE and exponential entity expansion in one rule, before any
 *      scanning happens — the reason a hand-written scanner is acceptable here
 *      and a permissive parser is not.
 *   2. Scanning is bounded by input bytes, total tag count and captured string
 *      length, so a hostile document cannot make the analyser expensive.
 *   3. This adapter DISCOVERS. It returns counts and identifiers. It never
 *      produces domain rows, and nothing it returns is written anywhere.
 */

import type { MigrationDiscovery, MigrationFormat, MigrationSourceAdapter } from "./tally-migration"

const MAX_BYTES = 25 * 1024 * 1024
const MAX_TAGS = 2_000_000
const MAX_CAPTURE = 200

/** Record elements Tally emits inside `<TALLYMESSAGE>`. */
const RECORD_ELEMENTS = [
  "VOUCHER",
  "STOCKITEM",
  "LEDGER",
  "GROUP",
  "STOCKGROUP",
  "UNIT",
  "GODOWN",
  "COSTCENTRE",
  "STOCKCATEGORY",
] as const

/** The five predefined XML entities. Nothing else is expanded, because nothing else may exist. */
const PREDEFINED: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
}

function decodePredefined(raw: string): string {
  return raw.replace(/&(amp|lt|gt|quot|apos);/g, (match) => PREDEFINED[match] ?? match)
}

/**
 * Removes every `open ... close` span in one linear pass.
 *
 * The obvious regular expression, `open[\s\S]*?close` under a global flag,
 * rescans to the end of the document from each `open` marker, so a body of
 * repeated `<!--` costs quadratic time before any size limit is consulted.
 * An unterminated `open` is left in place, which keeps it visible to the `<!`
 * check that rejects DOCTYPE and ENTITY declarations.
 */
export function stripDelimited(text: string, open: string, close: string): string {
  let kept = ""
  let index = 0
  while (index < text.length) {
    const start = text.indexOf(open, index)
    if (start === -1) break
    const end = text.indexOf(close, start + open.length)
    if (end === -1) break
    kept += text.slice(index, start)
    index = end + close.length
  }
  return kept + text.slice(index)
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern)
  return matches ? matches.length : 0
}

function firstCapture(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  const value = match?.[1]?.trim()
  return value ? decodePredefined(value).slice(0, MAX_CAPTURE) : undefined
}

/** Tally writes dates as `YYYYMMDD`; anything else is reported rather than guessed at. */
function parseTallyDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim())
  if (!match) return undefined
  const [, year, month, day] = match
  const asDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (Number.isNaN(asDate.getTime())) return undefined
  return asDate.toISOString().slice(0, 10)
}

export class TallyXmlAdapter implements MigrationSourceAdapter {
  readonly format: MigrationFormat = "tally-xml"

  analyse(input: Uint8Array, fileName: string): MigrationDiscovery {
    if (input.byteLength === 0) throw new Error("MIGRATION_EMPTY_FILE")
    if (input.byteLength > MAX_BYTES) throw new Error("MIGRATION_FILE_TOO_LARGE")
    if (!fileName.trim() || /[\0\r\n]/.test(fileName)) throw new Error("MIGRATION_INVALID_FILENAME")

    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input)
    } catch {
      throw new Error("MIGRATION_XML_NOT_UTF8")
    }

    // Rule 1: no DTD, therefore no entities beyond the five predefined ones.
    const body = stripDelimited(text, "<!--", "-->")
    if (/<!/.test(body)) {
      throw new Error("MIGRATION_XML_ENTITIES_REJECTED")
    }
    if (!text.includes("<")) throw new Error("MIGRATION_XML_MALFORMED")

    const tagCount = countMatches(text, /<[A-Za-z/]/g)
    if (tagCount > MAX_TAGS) throw new Error("MIGRATION_XML_TOO_COMPLEX")

    const warnings: string[] = []

    const messages = countMatches(body, /<TALLYMESSAGE\b/g)
    if (messages === 0) warnings.push("NO_TALLY_MESSAGES")

    const counts: Partial<Record<string, number>> = {}
    const recordTotal = RECORD_ELEMENTS.reduce((total, element) => {
      const found = countMatches(body, new RegExp(`<${element}\\b`, "g"))
      if (found > 0) counts[element] = found
      return total + found
    }, 0)

    if (messages > 0 && recordTotal === 0) warnings.push("NO_RECOGNISED_RECORDS")
    if (recordTotal > 0) counts.records = recordTotal

    // `<ENVELOPE>` with a `<HEADER>` but no `<BODY>` is the shape of a Tally
    // request/response envelope rather than an export; worth saying out loud
    // because importing it would discover nothing.
    if (body.includes("<ENVELOPE") && !body.includes("<BODY") && recordTotal === 0) {
      warnings.push("ENVELOPE_WITHOUT_BODY")
    }

    // Company identity appears either as a child element or as an attribute on
    // `<COMPANY>`. Both forms are used by different Tally export templates.
    const company =
      firstCapture(body, /<COMPANYNAME>([^<]{1,4096})<\/COMPANYNAME>/i) ??
      firstCapture(body, /<COMPANY\b[^>]*\bNAME="([^"]{1,4096})"/i)
    const currency =
      firstCapture(body, /<CURRENCYNAME>([^<]{1,4096})<\/CURRENCYNAME>/i) ??
      firstCapture(body, /<CURRENCY\b[^>]*\bNAME="([^"]{1,4096})"/i)

    if (!company) warnings.push("COMPANY_IDENTITY_MISSING")

    const fromRaw = firstCapture(body, /<SVFROMDATE[^>]*>([^<]{1,40})<\/SVFROMDATE>/i)
    const toRaw = firstCapture(body, /<SVTODATE[^>]*>([^<]{1,40})<\/SVTODATE>/i)
    const from = parseTallyDate(fromRaw)
    const to = parseTallyDate(toRaw)
    if ((fromRaw && !from) || (toRaw && !to)) warnings.push("FINANCIAL_PERIOD_UNREADABLE")

    const financialPeriod = from || to ? { from, to } : undefined

    return {
      format: "tally-xml",
      company,
      currency,
      financialPeriod,
      counts,
      warnings,
    }
  }
}

/** Exposed for tests and for the upload gate, so the bound is stated once. */
export const TALLY_XML_LIMITS = { MAX_BYTES, MAX_TAGS, MAX_CAPTURE } as const

export const TALLY_XML_RECORD_ELEMENTS = RECORD_ELEMENTS
