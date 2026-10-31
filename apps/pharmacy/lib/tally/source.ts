/**
 * Format dispatch for a Tally cut-over file.
 *
 * Magic bytes decide, not the file name: a renamed export still parses as what
 * it actually is, and an unrecognised binary is refused before any parser runs.
 */

import { parseTallyXmlRows, type TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import { parseTallyCsv } from "./csv"
import { buildTallyDocument, readTallyWorkbook } from "./workbook"

export type TallySourceFormat = "xml" | "xlsx" | "xls" | "csv"

export class TallySourceError extends Error {
  constructor(message: string, readonly code = "TALLY_FORMAT_UNSUPPORTED") {
    super(message)
    this.name = "TallySourceError"
  }
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

function isOle(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  )
}

export function detectTallyFormat(bytes: Uint8Array, fileName?: string): TallySourceFormat {
  if (isOle(bytes)) {
    return "xls"
  }
  if (isZip(bytes)) {
    // .xlsx is a zip; anything else zipped is not a workbook we can read.
    const name = (fileName ?? "").toLowerCase()
    if (name && !name.endsWith(".xlsx")) {
      throw new TallySourceError("Only .xlsx workbooks are supported, not other archive files.")
    }
    return "xlsx"
  }

  let index = 0
  // Skip a UTF-8 BOM and leading whitespace before deciding text format.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x0a || bytes[index] === 0x0d || bytes[index] === 0x09)) {
    index += 1
  }
  if (bytes[index] === 0x3c) return "xml"

  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 8192))
    .replace(/^﻿/, "")
    .toLowerCase()
  if (head.includes("record_type")) return "csv"

  throw new TallySourceError(
    "File is not Tally XML, an .xlsx workbook, or a flat CSV with a record_type column.",
  )
}

export function readTallyDocument(
  bytes: Uint8Array,
  fileName?: string,
): { format: TallySourceFormat; document: TallyXmlDocument } {
  const format = detectTallyFormat(bytes, fileName)
  if (format === "xml") {
    return { format, document: parseTallyXmlRows(bytes, fileName) }
  }
  if (format === "xlsx" || format === "xls") {
    return { format, document: buildTallyDocument(readTallyWorkbook(bytes)) }
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes,
  )
  return { format, document: parseTallyCsv(text) }
}
