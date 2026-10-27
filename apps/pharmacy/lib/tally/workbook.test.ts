import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import { TallyTemplateError, buildTallyDocument, readTallyWorkbook } from "./workbook"

type Sheet = [string, unknown[][]]

function workbookBytes(sheets: Sheet[]): Uint8Array {
  const workbook = XLSX.utils.book_new()
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

const REQUIRED: Sheet[] = [
  ["Meta", [["key", "value"], ["company", "Test Pharmacy"], ["currency", "UGX"]]],
  ["Accounts", [["name", "parent"], ["Test Bank", "Bank Accounts"], ["Test Capital", "Capital Account"]]],
  ["StockItems", [["name"], ["Test Item A"]]],
  ["Vouchers", [["id", "type", "date"], ["V-1", "Journal", "2026-04-01"]]],
  [
    "VoucherLines",
    [
      ["voucher_id", "ledger", "debit", "credit"],
      ["V-1", "Test Bank", "1000", ""],
      ["V-1", "Test Capital", "", "1000"],
    ],
  ],
]

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof TallyTemplateError ? error.code : `unexpected:${String(error)}`
  }
}

describe("readTallyWorkbook", () => {
  it("reads the normalised sheets and keeps optional sheets empty", () => {
    const records = readTallyWorkbook(workbookBytes(REQUIRED))

    expect(records.accounts).toEqual([
      { name: "Test Bank", parent: "Bank Accounts" },
      { name: "Test Capital", parent: "Capital Account" },
    ])
    expect(records.stockItems).toEqual([{ name: "Test Item A" }])
    expect(records.stockBatches).toEqual([])
    expect(records.bills).toEqual([])
  })

  it("rejects a workbook missing a required sheet", () => {
    expect(errorCode(() => readTallyWorkbook(workbookBytes(REQUIRED.filter(([name]) => name !== "Vouchers"))))).toBe(
      "TALLY_TEMPLATE_MISSING_SHEET",
    )
  })

  it("rejects a required column that is absent", () => {
    const sheets = REQUIRED.map(
      ([name, rows]) => [name, name === "Accounts" ? [["name"]] : rows] as Sheet,
    )
    expect(errorCode(() => readTallyWorkbook(workbookBytes(sheets)))).toBe("TALLY_TEMPLATE_INVALID")
  })

  it("rejects an unknown column so a typo cannot be ignored", () => {
    const sheets = REQUIRED.map(
      ([name, rows]) =>
        [name, name === "Vouchers" ? [["id", "type", "date", "narration "]] : rows] as Sheet,
    )
    // A trailing space normalises to the known "narration" column, which is allowed.
    expect(errorCode(() => readTallyWorkbook(workbookBytes(sheets)))).toBeUndefined()

    const misspelled = REQUIRED.map(
      ([name, rows]) => [name, name === "Vouchers" ? [["id", "tpye", "date"]] : rows] as Sheet,
    )
    expect(errorCode(() => readTallyWorkbook(workbookBytes(misspelled)))).toBe("TALLY_TEMPLATE_INVALID")
  })

  it("rejects a sheet that repeats a column", () => {
    const sheets = REQUIRED.map(
      ([name, rows]) => [name, name === "Accounts" ? [["name", "parent", "name"]] : rows] as Sheet,
    )
    expect(errorCode(() => readTallyWorkbook(workbookBytes(sheets)))).toBe("TALLY_TEMPLATE_INVALID")
  })
})

describe("buildTallyDocument", () => {
  it("turns template rows into the same shape the XML parser produces", () => {
    const document = buildTallyDocument(readTallyWorkbook(workbookBytes(REQUIRED)))

    expect(document.company).toBe("Test Pharmacy")
    expect(document.currency).toBe("UGX")
    expect(document.groups.map((group) => group.name)).toEqual(["Bank Accounts", "Capital Account"])
    expect(document.ledgers.map((ledger) => ledger.name)).toEqual(["Test Bank", "Test Capital"])

    expect(document.vouchers).toHaveLength(1)
    const voucher = document.vouchers[0]!
    expect(voucher.remoteId).toBe("V-1")
    expect(voucher.date).toBe("2026-04-01")
    expect(voucher.ledgerLines).toEqual([
      { ledgerName: "Test Bank", side: "debit", amount: 1000, isParty: false, narration: undefined, bills: [] },
      { ledgerName: "Test Capital", side: "credit", amount: 1000, isParty: false, narration: undefined, bills: [] },
    ])
  })

  it("reads a date-typed cell that Excel stores as a serial", () => {
    const workbook = XLSX.utils.book_new()
    for (const [name, rows] of REQUIRED) {
      const sheet = XLSX.utils.aoa_to_sheet(rows)
      if (name === "Vouchers") {
        // What Excel writes for a real date cell: a serial plus a date format.
        sheet.C2 = { t: "n", v: 46023, z: "dd/mm/yyyy" }
      }
      XLSX.utils.book_append_sheet(workbook, sheet, name)
    }
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer)

    const document = buildTallyDocument(readTallyWorkbook(bytes))

    expect(document.vouchers[0]?.date).toBe("2026-01-01")
    expect(document.warnings).not.toContain("DATE_UNREADABLE")
  })

  it("attaches opening batches to their stock item", () => {
    const sheets: Sheet[] = [
      ...REQUIRED,
      [
        "StockBatches",
        [
          ["stock_item", "batch", "expiry", "quantity", "amount"],
          ["Test Item A", "B-1", "2027-01-31", "10", "500"],
        ],
      ],
    ]
    const document = buildTallyDocument(readTallyWorkbook(workbookBytes(sheets)))
    const item = document.stockItems[0]!
    expect(item.batchWise).toBe(true)
    expect(item.batches).toEqual([
      { batchName: "B-1", expiryDate: "2027-01-31", quantity: 10, amount: 500, godown: undefined },
    ])
  })

  it("refuses a repeated voucher id", () => {
    const sheets = REQUIRED.map(
      ([name, rows]) =>
        [name, name === "Vouchers" ? [["id", "type", "date"], ["V-1", "Journal", "2026-04-01"], ["V-1", "Journal", "2026-04-02"]] : rows] as Sheet,
    )
    expect(errorCode(() => buildTallyDocument(readTallyWorkbook(workbookBytes(sheets))))).toBe(
      "TALLY_TEMPLATE_INVALID",
    )
  })

  it("refuses a line carrying both a debit and a credit", () => {
    const sheets = REQUIRED.map(
      ([name, rows]) =>
        [name, name === "VoucherLines" ? [["voucher_id", "ledger", "debit", "credit"], ["V-1", "Test Bank", "10", "10"]] : rows] as Sheet,
    )
    expect(errorCode(() => buildTallyDocument(readTallyWorkbook(workbookBytes(sheets))))).toBe(
      "TALLY_TEMPLATE_INVALID",
    )
  })
})
