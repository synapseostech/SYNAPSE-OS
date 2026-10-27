/**
 * Normalised Tally workbook template.
 *
 * Tally's own Excel reports have no stable layout, so the portal accepts only
 * this documented workbook (or Tally XML, which keeps full fidelity). Every
 * sheet is validated by header before a single row is trusted.
 */

import * as XLSX from "xlsx"
import {
  parseTallyAmount,
  parseTallyRowDate,
  type TallyBillAllocation,
  type TallyGroup,
  type TallyInventoryLine,
  type TallyLedger,
  type TallyLedgerLine,
  type TallyStockGroup,
  type TallyStockItem,
  type TallyVoucher,
  type TallyXmlDocument,
  type TallyXmlRowWarning,
} from "@synapse/db/tally-xml-rows"

export const TALLY_TABULAR_LIMITS = {
  MAX_ROWS: 200_000,
  MAX_TOTAL_ROWS: 500_000,
  MAX_TEXT: 4096,
}

export class TallyTemplateError extends Error {
  constructor(
    message: string,
    readonly code:
      | "TALLY_TEMPLATE_INVALID"
      | "TALLY_TEMPLATE_TOO_LARGE"
      | "TALLY_TEMPLATE_MISSING_SHEET",
  ) {
    super(message)
    this.name = "TallyTemplateError"
  }
}

export type TallyRow = Record<string, unknown>

export type TallyTabularRecords = {
  meta: TallyRow[]
  accounts: TallyRow[]
  stockItems: TallyRow[]
  stockBatches: TallyRow[]
  vouchers: TallyRow[]
  voucherLines: TallyRow[]
  stockLines: TallyRow[]
  bills: TallyRow[]
}

type SheetSpec = {
  key: keyof TallyTabularRecords
  sheet: string
  required: boolean
  columns: Array<{ name: string; required: boolean }>
}

const cols = (...names: string[]) => names.map((name) => ({ name, required: true }))
const opt = (...names: string[]) => names.map((name) => ({ name, required: false }))

export const TALLY_SHEETS: SheetSpec[] = [
  { key: "meta", sheet: "Meta", required: true, columns: cols("key", "value") },
  {
    key: "accounts",
    sheet: "Accounts",
    required: true,
    columns: [
      ...cols("name", "parent"),
      ...opt("guid", "opening_balance", "closing_balance", "email", "phone", "address"),
    ],
  },
  {
    key: "stockItems",
    sheet: "StockItems",
    required: true,
    columns: [
      ...cols("name"),
      ...opt("guid", "parent", "unit", "opening_quantity", "opening_rate", "opening_value"),
    ],
  },
  {
    key: "stockBatches",
    sheet: "StockBatches",
    required: false,
    columns: [
      ...cols("stock_item"),
      ...opt("batch", "expiry", "quantity", "amount", "godown"),
    ],
  },
  {
    key: "vouchers",
    sheet: "Vouchers",
    required: true,
    columns: [
      ...cols("id", "type", "date"),
      ...opt("guid", "number", "party", "narration", "currency", "cancelled"),
    ],
  },
  {
    key: "voucherLines",
    sheet: "VoucherLines",
    required: true,
    columns: [...cols("voucher_id", "ledger"), ...opt("debit", "credit", "narration", "party")],
  },
  {
    key: "stockLines",
    sheet: "StockLines",
    required: false,
    columns: [
      ...cols("voucher_id", "stock_item"),
      ...opt("quantity", "unit", "rate", "amount", "godown", "batch", "expiry", "account_ledger"),
    ],
  },
  {
    key: "bills",
    sheet: "BillAllocations",
    required: false,
    columns: [...cols("ledger", "name", "amount"), ...opt("bill_type", "credit_days")],
  },
]

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

function date(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // SheetJS hands back a typed date cell at local midnight of the calendar
    // day, so the local components are the cell's date in every timezone;
    // toISOString would shift the day west of UTC.
    const month = String(value.getMonth() + 1).padStart(2, "0")
    const day = String(value.getDate()).padStart(2, "0")
    return `${value.getFullYear()}-${month}-${day}`
  }
  return parseTallyRowDate(text(value))
}

function bool(value: unknown): boolean {
  const raw = text(value)?.toLowerCase()
  return raw === "yes" || raw === "true" || raw === "1" || raw === "y"
}

function readSheetRows(
  workbook: XLSX.WorkBook,
  spec: SheetSpec,
): TallyRow[] {
  const sheet = workbook.Sheets[spec.sheet]
  if (!sheet) {
    if (spec.required) {
      throw new TallyTemplateError(
        `Workbook is missing the "${spec.sheet}" sheet.`,
        "TALLY_TEMPLATE_MISSING_SHEET",
      )
    }
    return []
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  })
  if (matrix.length === 0) {
    if (spec.required) {
      throw new TallyTemplateError(
        `Sheet "${spec.sheet}" is empty.`,
        "TALLY_TEMPLATE_INVALID",
      )
    }
    return []
  }

  const header = (matrix[0] ?? []).map(headerKey)
  const allowed = new Set(spec.columns.map((column) => column.name))
  for (const column of spec.columns) {
    if (column.required && !header.includes(column.name)) {
      throw new TallyTemplateError(
        `Sheet "${spec.sheet}" is missing the "${column.name}" column.`,
        "TALLY_TEMPLATE_INVALID",
      )
    }
  }
  const unknown = header.filter((name) => name && !allowed.has(name))
  if (unknown.length > 0) {
    throw new TallyTemplateError(
      `Sheet "${spec.sheet}" has unknown column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      "TALLY_TEMPLATE_INVALID",
    )
  }
  if (new Set(header).size !== header.length) {
    throw new TallyTemplateError(
      `Sheet "${spec.sheet}" repeats a column.`,
      "TALLY_TEMPLATE_INVALID",
    )
  }

  const rows: TallyRow[] = []
  for (const values of matrix.slice(1)) {
    if (rows.length >= TALLY_TABULAR_LIMITS.MAX_ROWS) {
      throw new TallyTemplateError(
        `Sheet "${spec.sheet}" has more than ${TALLY_TABULAR_LIMITS.MAX_ROWS} rows.`,
        "TALLY_TEMPLATE_TOO_LARGE",
      )
    }
    const row: TallyRow = {}
    let filled = false
    header.forEach((name, index) => {
      if (!name) return
      const raw = values[index]
      if (raw === "" || raw === null || raw === undefined) return
      row[name] = raw
      filled = true
    })
    if (filled) rows.push(row)
  }
  return rows
}

export function readTallyWorkbook(bytes: Uint8Array): TallyTabularRecords {
  const workbook = XLSX.read(bytes, {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    // Without this a date-formatted cell stays a numeric serial, which the row
    // date reader rejects — every real date cell would be skipped as unreadable.
    cellDates: true,
    sheetRows: TALLY_TABULAR_LIMITS.MAX_ROWS + 2,
  })

  const records = {} as TallyTabularRecords
  let total = 0
  for (const spec of TALLY_SHEETS) {
    const rows = readSheetRows(workbook, spec)
    total += rows.length
    if (total > TALLY_TABULAR_LIMITS.MAX_TOTAL_ROWS) {
      throw new TallyTemplateError(
        `Workbook has more than ${TALLY_TABULAR_LIMITS.MAX_TOTAL_ROWS} rows.`,
        "TALLY_TEMPLATE_TOO_LARGE",
      )
    }
    records[spec.key] = rows
  }
  return records
}

function metaValue(records: TallyRow[], key: string): string | undefined {
  const wanted = key.toLowerCase()
  const row = records.find((entry) => headerKey(entry.key) === wanted)
  return text(row?.value)
}

/**
 * Turns template rows into the same document the XML parser produces, so the
 * normaliser and every downstream guard behave identically for both formats.
 */
export function buildTallyDocument(records: TallyTabularRecords): TallyXmlDocument {
  const warnings: TallyXmlRowWarning[] = []

  const groups: TallyGroup[] = []
  const groupKeys = new Set<string>()
  const addGroup = (name: string | undefined) => {
    const label = text(name, 120)
    if (!label) return
    const key = label.toLowerCase()
    if (groupKeys.has(key)) return
    groupKeys.add(key)
    groups.push({ name: label })
  }

  const billsByLedger = new Map<string, TallyBillAllocation[]>()
  for (const row of records.bills) {
    const ledger = text(row.ledger, 200)
    const name = text(row.name, 120)
    if (!ledger || !name) continue
    const items = billsByLedger.get(ledger) ?? []
    items.push({
      name,
      billType: text(row.bill_type, 40),
      amount: number(row.amount) ?? 0,
      creditPeriodDays: number(row.credit_days),
    })
    billsByLedger.set(ledger, items)
  }

  const ledgers: TallyLedger[] = []
  const ledgerKeys = new Set<string>()
  for (const row of records.accounts) {
    const name = text(row.name, 200)
    if (!name) continue
    const key = name.toLowerCase().replace(/\s+/g, " ")
    if (ledgerKeys.has(key)) continue
    ledgerKeys.add(key)
    const parent = text(row.parent, 120)
    addGroup(parent)
    const bills = billsByLedger.get(name) ?? []
    ledgers.push({
      guid: text(row.guid, 80),
      name,
      parent,
      openingBalance: number(row.opening_balance),
      closingBalance: number(row.closing_balance),
      isBillWise: bills.length > 0,
      email: text(row.email, 200),
      phone: text(row.phone, 40),
      address: text(row.address, 300),
      bills,
    })
  }

  const batchesByItem = new Map<string, TallyStockItem["batches"]>()
  for (const row of records.stockBatches) {
    const item = text(row.stock_item, 200)
    if (!item) continue
    const batches = batchesByItem.get(item) ?? []
    batches.push({
      batchName: text(row.batch, 120),
      expiryDate: date(row.expiry),
      quantity: number(row.quantity),
      amount: number(row.amount),
      godown: text(row.godown, 120),
    })
    batchesByItem.set(item, batches)
  }

  const stockGroups: TallyStockGroup[] = []
  const stockGroupKeys = new Set<string>()
  const stockItems: TallyStockItem[] = []
  const stockItemKeys = new Set<string>()
  for (const row of records.stockItems) {
    const name = text(row.name, 200)
    if (!name) continue
    const key = name.toLowerCase().replace(/\s+/g, " ")
    if (stockItemKeys.has(key)) continue
    stockItemKeys.add(key)
    const parent = text(row.parent, 120)
    if (parent && !stockGroupKeys.has(parent.toLowerCase())) {
      stockGroupKeys.add(parent.toLowerCase())
      stockGroups.push({ name: parent })
    }
    const batches = batchesByItem.get(name) ?? []
    stockItems.push({
      guid: text(row.guid, 80),
      name,
      parent,
      baseUnit: text(row.unit, 40),
      openingQuantity: number(row.opening_quantity),
      openingRate: number(row.opening_rate),
      openingValue: number(row.opening_value),
      batchWise: batches.length > 0,
      batches,
    })
  }

  const vouchersById = new Map<string, TallyVoucher>()
  for (const row of records.vouchers) {
    const id = text(row.id, 80)
    if (!id) continue
    if (vouchersById.has(id)) {
      throw new TallyTemplateError(
        `Vouchers sheet repeats the id "${id}".`,
        "TALLY_TEMPLATE_INVALID",
      )
    }
    const voucherDate = date(row.date)
    if (!voucherDate) warnings.push("DATE_UNREADABLE")
    vouchersById.set(id, {
      guid: text(row.guid, 80),
      remoteId: id,
      type: text(row.type, 40) ?? "",
      number: text(row.number, 80),
      date: voucherDate,
      narration: text(row.narration, 500),
      partyLedgerName: text(row.party, 200),
      currency: text(row.currency, 8),
      isCancelled: bool(row.cancelled),
      ledgerLines: [],
      inventoryLines: [],
    })
  }

  for (const row of records.voucherLines) {
    const voucher = vouchersById.get(text(row.voucher_id, 80) ?? "")
    if (!voucher) continue
    const ledgerName = text(row.ledger, 200)
    if (!ledgerName) continue
    const debit = number(row.debit) ?? 0
    const credit = number(row.credit) ?? 0
    if (debit > 0 && credit > 0) {
      throw new TallyTemplateError(
        `Voucher line for "${ledgerName}" has both debit and credit.`,
        "TALLY_TEMPLATE_INVALID",
      )
    }
    if (debit === 0 && credit === 0) continue
    voucher.ledgerLines.push({
      ledgerName,
      side: debit > 0 ? "debit" : "credit",
      amount: Math.abs(debit > 0 ? debit : credit),
      isParty: ledgerName.toLowerCase() === (voucher.partyLedgerName ?? "").toLowerCase(),
      narration: text(row.narration, 500),
      bills: [],
    })
  }

  for (const row of records.stockLines) {
    const voucherId = text(row.voucher_id, 80)
    const stockItemName = text(row.stock_item, 200)
    const voucher = voucherId ? vouchersById.get(voucherId) : undefined
    if (!voucher || !stockItemName) continue
    const line: TallyInventoryLine = {
      stockItemName,
      quantity: number(row.quantity),
      unit: text(row.unit, 40),
      rate: number(row.rate),
      amount: number(row.amount) ?? 0,
      godown: text(row.godown, 120),
      batches: [],
      ledgers: [],
    }
    const batchName = text(row.batch, 120)
    const expiry = date(row.expiry)
    if (batchName || expiry) {
      line.batches.push({
        batchName,
        expiryDate: expiry,
        quantity: line.quantity,
        amount: line.amount,
        godown: line.godown,
      })
    }
    const accountLedger = text(row.account_ledger, 200)
    if (accountLedger) {
      line.ledgers.push({
        ledgerName: accountLedger,
        side: "credit",
        amount: line.amount,
        isParty: false,
        bills: [],
      })
    }
    voucher.inventoryLines.push(line)
  }

  // An inventory line's own accounting allocation is optional: the voucher
  // ledger lines above carry the balanced postings either way.
  return {
    company: metaValue(records.meta, "company"),
    companyGuid: metaValue(records.meta, "company_guid"),
    currency: metaValue(records.meta, "currency"),
    financialPeriod: {
      from: date(metaValue(records.meta, "period_from")),
      to: date(metaValue(records.meta, "period_to")),
    },
    groups,
    ledgers,
    stockGroups,
    stockItems,
    units: [],
    godowns: [],
    vouchers: [...vouchersById.values()],
    warnings,
  }
}
