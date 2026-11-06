/**
 * The stock sheet: a one-sheet workbook listing each stock item's batches and
 * expiry dates.
 *
 * Tally's masters export carries no batch allocation and no expiry, so opening
 * stock cannot be received into sellable batches from the export alone. The
 * operator downloads a sheet pre-filled from the staged masters, adds a batch
 * and expiry per item, and attaches it. Its rows are merged into the document
 * before it is normalised, so the ordinary stock guards judge them.
 */

import * as XLSX from "xlsx"
import { normaliseTallyKey } from "@synapse/db/tally-map"
import {
  parseTallyAmount,
  parseTallyRowDate,
  type TallyBatchAllocation,
  type TallyStockItem,
  type TallyXmlDocument,
} from "@synapse/db/tally-xml-rows"
import { TALLY_TABULAR_LIMITS } from "./workbook"

export const STOCK_SHEET_NAME = "StockBatches"
export const STOCK_SHEET_COLUMNS = [
  "stock_item",
  "batch",
  "expiry",
  "quantity",
  "amount",
  "godown",
] as const

const MAX_PROBLEMS = 20

export class TallyStockSheetError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "TallyStockSheetError"
  }
}

export type TallyStockSheetRow = {
  /** 1-based sheet row, so a problem names the line the operator can see. */
  row: number
  item: string
  batch?: string
  expiry?: string
  quantity?: number
  amount?: number
  godown?: string
}

export type TallyStockSheet = {
  rows: TallyStockSheetRow[]
  /** The first problems found, in sheet order. */
  problems: string[]
  /** How many further problems were found but not listed. */
  problemsOmitted: number
}

function headerKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

function text(value: unknown, max = TALLY_TABULAR_LIMITS.MAX_TEXT): string | undefined {
  if (value === null || value === undefined) return undefined
  const raw = String(value).trim()
  return raw ? raw.slice(0, max) : undefined
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  return parseTallyAmount(String(value))
}

/** The day-first form a person types into a hand-filled sheet, e.g. 31/12/2027. */
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/

function date(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // A date-formatted cell arrives at local midnight of the calendar day.
    const month = String(value.getMonth() + 1).padStart(2, "0")
    const day = String(value.getDate()).padStart(2, "0")
    return `${value.getFullYear()}-${month}-${day}`
  }
  const raw = text(value)
  const parsed = parseTallyRowDate(raw)
  if (parsed) return parsed
  const match = raw ? DAY_FIRST.exec(raw) : null
  if (!match) return undefined
  const iso = `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`
  // Re-reading the ISO form rejects a day that does not exist in that month.
  return parseTallyRowDate(iso)
}

export function readTallyStockSheet(bytes: Uint8Array): TallyStockSheet {
  const workbook = XLSX.read(bytes, {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    cellDates: true,
    sheetRows: TALLY_TABULAR_LIMITS.MAX_ROWS + 2,
  })

  const sheetName =
    Object.keys(workbook.Sheets).find(
      (name) => name.trim().toLowerCase() === STOCK_SHEET_NAME.toLowerCase(),
    ) ?? (Object.keys(workbook.Sheets).length === 1 ? Object.keys(workbook.Sheets)[0] : undefined)
  if (!sheetName) {
    throw new TallyStockSheetError(
      `Workbook has no "${STOCK_SHEET_NAME}" sheet. Download the stock sheet again and fill that one.`,
      "TALLY_STOCK_SHEET_MISSING",
    )
  }

  const sheet = workbook.Sheets[sheetName]!
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  })
  if (matrix.length === 0) {
    throw new TallyStockSheetError(
      `Sheet "${sheetName}" is empty.`,
      "TALLY_STOCK_SHEET_INVALID",
    )
  }

  const header = (matrix[0] ?? []).map(headerKey)
  if (!header.includes("stock_item")) {
    throw new TallyStockSheetError(
      `Sheet "${sheetName}" is missing the "stock_item" column.`,
      "TALLY_STOCK_SHEET_INVALID",
    )
  }
  const allowed = new Set<string>(STOCK_SHEET_COLUMNS)
  const unknown = header.filter((name) => name && !allowed.has(name))
  if (unknown.length > 0) {
    throw new TallyStockSheetError(
      `Sheet "${sheetName}" has unknown column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      "TALLY_STOCK_SHEET_INVALID",
    )
  }
  if (new Set(header).size !== header.length) {
    throw new TallyStockSheetError(
      `Sheet "${sheetName}" repeats a column.`,
      "TALLY_STOCK_SHEET_INVALID",
    )
  }

  const rows: TallyStockSheetRow[] = []
  const problems: string[] = []
  let problemsOmitted = 0
  const problem = (message: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(message)
    else problemsOmitted += 1
  }
  // A partially filled sheet is the normal case, so blank cells are counted
  // and said once rather than once per row.
  let blankExpiry = 0

  matrix.slice(1).forEach((values, index) => {
    if (rows.length >= TALLY_TABULAR_LIMITS.MAX_ROWS) {
      throw new TallyStockSheetError(
        `Sheet "${sheetName}" has more than ${TALLY_TABULAR_LIMITS.MAX_ROWS} rows.`,
        "TALLY_STOCK_SHEET_TOO_LARGE",
      )
    }
    const cell = (name: string) => {
      const at = header.indexOf(name)
      return at === -1 ? undefined : values[at]
    }
    const item = text(cell("stock_item"), 200)
    if (!item) return

    const line = index + 2
    const expiry = date(cell("expiry"))
    if (!expiry) {
      if (text(cell("expiry"))) {
        problem(`Row ${line}: "${item}" has an expiry that could not be read as a date.`)
      } else {
        blankExpiry += 1
      }
    }
    const quantity = number(cell("quantity"))
    if (quantity === undefined) {
      problem(`Row ${line}: "${item}" has no quantity, so the batch cannot be received.`)
    }

    rows.push({
      row: line,
      item,
      ...(text(cell("batch"), 120) ? { batch: text(cell("batch"), 120)! } : {}),
      ...(expiry ? { expiry } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(number(cell("amount")) !== undefined ? { amount: number(cell("amount"))! } : {}),
      ...(text(cell("godown"), 120) ? { godown: text(cell("godown"), 120)! } : {}),
    })
  })

  if (blankExpiry > 0) {
    problem(
      `${blankExpiry} row${blankExpiry === 1 ? "" : "s"} ${blankExpiry === 1 ? "has" : "have"} no expiry, so ${blankExpiry === 1 ? "it creates" : "they create"} no batch.`,
    )
  }

  return { rows, problems, problemsOmitted }
}

export type TallyStockSheetMerge = {
  document: TallyXmlDocument
  /** Rows that became a batch. */
  applied: number
  /** Items the sheet names that the masters do not hold. */
  unmatched: string[]
  /** Rows skipped because they carry no expiry. */
  withoutExpiry: number
}

/**
 * Replaces the batch list of every item the sheet names with the sheet's rows.
 *
 * A sheet is the operator's statement of that item's batches, so a row set for
 * an item is the whole set: a partially-listed item would otherwise keep the
 * export's batches beside the typed ones.
 */
export function applyTallyStockSheet(
  document: TallyXmlDocument,
  sheet: TallyStockSheet,
): TallyStockSheetMerge {
  const stockItems = [...document.stockItems]
  const indexByKey = new Map<string, number>()
  stockItems.forEach((item, index) => {
    const key = normaliseTallyKey(item.name)
    if (!indexByKey.has(key)) indexByKey.set(key, index)
  })

  const replaced = new Set<string>()
  const unmatched: string[] = []
  let applied = 0
  let withoutExpiry = 0

  for (const row of sheet.rows) {
    const key = normaliseTallyKey(row.item)
    const index = indexByKey.get(key)
    if (index === undefined) {
      if (!unmatched.includes(row.item)) unmatched.push(row.item)
      continue
    }
    if (!row.expiry) {
      withoutExpiry += 1
      continue
    }

    let item = stockItems[index]!
    if (!replaced.has(key)) {
      item = { ...item, batches: [], batchWise: true }
      stockItems[index] = item
      replaced.add(key)
    }
    const batch: TallyBatchAllocation = {
      batchName: row.batch,
      expiryDate: row.expiry,
      quantity: row.quantity,
      amount: row.amount,
      godown: row.godown,
    }
    stockItems[index] = { ...item, batches: [...item.batches, batch] }
    applied += 1
  }

  return {
    document: { ...document, stockItems },
    applied,
    unmatched,
    withoutExpiry,
  }
}

/**
 * The sheet an operator fills: every item the cut-over will receive stock for,
 * with its quantity and value already in place, so only the batch and expiry
 * are typed.
 */
export function buildTallyStockSheet(
  document: TallyXmlDocument,
  mode: "opening" | "closing",
): ArrayBuffer {
  const lines: Array<Array<string | number>> = [[...STOCK_SHEET_COLUMNS]]
  const items: TallyStockItem[] = [...document.stockItems].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  for (const item of items) {
    const quantity = mode === "closing" ? item.closingQuantity : item.openingQuantity
    if (quantity === undefined || quantity <= 0) continue
    const value = mode === "closing" ? item.closingValue : item.openingValue
    lines.push([
      item.name,
      "",
      "",
      quantity,
      value === undefined ? "" : Math.abs(value),
      "",
    ])
  }

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(lines), STOCK_SHEET_NAME)

  const help = XLSX.utils.aoa_to_sheet([
    ["How to fill this sheet"],
    [""],
    ["One row per batch. Type the batch name (if Tally uses one) and the expiry date (YYYY-MM-DD)."],
    ["The quantity is the number of whole units in that batch. Split an item across several rows when it expires on different dates."],
    ["Leave stock_item exactly as it is: it is matched to the masters by name."],
    ["A row without an expiry creates no sellable batch, so the opening stock would stay in the ledger only."],
  ])
  XLSX.utils.book_append_sheet(workbook, help, "Read me")

  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer
}
