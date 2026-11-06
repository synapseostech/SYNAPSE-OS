import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import type { TallyStockItem, TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import {
  TallyStockSheetError,
  applyTallyStockSheet,
  buildTallyStockSheet,
  readTallyStockSheet,
} from "./stock-sheet"

function workbookBytes(sheets: Array<[string, unknown[][]]>): Uint8Array {
  const workbook = XLSX.utils.book_new()
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

function sheetBytes(rows: unknown[][]): Uint8Array {
  return workbookBytes([["StockBatches", rows]])
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof TallyStockSheetError ? error.code : `unexpected:${String(error)}`
  }
}

function item(name: string, overrides: Partial<TallyStockItem> = {}): TallyStockItem {
  return { name, batchWise: false, batches: [], ...overrides }
}

function documentWith(stockItems: TallyStockItem[]): TallyXmlDocument {
  return {
    financialPeriod: {},
    groups: [],
    ledgers: [],
    stockGroups: [],
    stockItems,
    units: [],
    godowns: [],
    vouchers: [],
    warnings: [],
  }
}

describe("readTallyStockSheet", () => {
  it("reads a filled sheet and ignores the instructions sheet", () => {
    const sheet = readTallyStockSheet(
      workbookBytes([
        [
          "StockBatches",
          [
            ["stock_item", "batch", "expiry", "quantity", "amount", "godown"],
            ["Panadol 500mg", "B-1", "2027-03-31", 24, 12000, "Main"],
            ["Amoxil 250mg", "", "31/12/2026", 10, "", ""],
          ],
        ],
        ["Read me", [["How to fill this sheet"]]],
      ]),
    )

    expect(sheet.rows).toEqual([
      {
        row: 2,
        item: "Panadol 500mg",
        batch: "B-1",
        expiry: "2027-03-31",
        quantity: 24,
        amount: 12000,
        godown: "Main",
      },
      { row: 3, item: "Amoxil 250mg", expiry: "2026-12-31", quantity: 10 },
    ])
    expect(sheet.problems).toEqual([])
  })

  it("reports rows a batch cannot be received from, without dropping them", () => {
    const sheet = readTallyStockSheet(
      sheetBytes([
        ["stock_item", "batch", "expiry", "quantity", "amount", "godown"],
        ["Panadol 500mg", "", "", 24, "", ""],
        ["Amoxil 250mg", "", "not-a-date", "", "", ""],
      ]),
    )

    expect(sheet.rows.map((row) => row.item)).toEqual(["Panadol 500mg", "Amoxil 250mg"])
    expect(sheet.problems).toEqual([
      'Row 3: "Amoxil 250mg" has an expiry that could not be read as a date.',
      'Row 3: "Amoxil 250mg" has no quantity, so the batch cannot be received.',
      "1 row has no expiry, so it creates no batch.",
    ])
  })

  it("refuses a workbook that is not the stock sheet", () => {
    const other = workbookBytes([
      ["Accounts", [["name"]],],
      ["Vouchers", [["id"]]],
    ])
    expect(errorCode(() => readTallyStockSheet(other))).toBe("TALLY_STOCK_SHEET_MISSING")
  })

  it("refuses a sheet without its item column", () => {
    expect(
      errorCode(() => readTallyStockSheet(sheetBytes([["batch", "expiry"], ["B-1", "2027-03-31"]]))),
    ).toBe("TALLY_STOCK_SHEET_INVALID")
  })
})

describe("applyTallyStockSheet", () => {
  it("replaces the batches of the items it names and leaves the rest alone", () => {
    const exported = item("Panadol 500mg", {
      batches: [{ batchName: "OLD", expiryDate: "2020-01-01", quantity: 5 }],
      batchWise: true,
    })
    const untouched = item("Amoxil 250mg")

    const merge = applyTallyStockSheet(documentWith([exported, untouched]), {
      rows: [
        { row: 2, item: "panadol 500mg", batch: "B-1", expiry: "2027-03-31", quantity: 24 },
        { row: 3, item: "Panadol 500mg", batch: "B-2", expiry: "2027-06-30", quantity: 12 },
        { row: 4, item: "Unknown item", expiry: "2027-03-31", quantity: 1 },
        { row: 5, item: "Amoxil 250mg", quantity: 10 },
      ],
      problems: [],
      problemsOmitted: 0,
    })

    expect(merge.applied).toBe(2)
    expect(merge.unmatched).toEqual(["Unknown item"])
    expect(merge.withoutExpiry).toBe(1)
    expect(merge.document.stockItems[0]).toMatchObject({
      name: "Panadol 500mg",
      batchWise: true,
      batches: [
        { batchName: "B-1", expiryDate: "2027-03-31", quantity: 24 },
        { batchName: "B-2", expiryDate: "2027-06-30", quantity: 12 },
      ],
    })
    // An item the sheet only names without an expiry keeps what it had.
    expect(merge.document.stockItems[1]).toBe(untouched)
  })

  it("does not change the document it was given", () => {
    const exported = item("Panadol 500mg")
    const original = documentWith([exported])

    applyTallyStockSheet(original, {
      rows: [{ row: 2, item: "Panadol 500mg", expiry: "2027-03-31", quantity: 24 }],
      problems: [],
      problemsOmitted: 0,
    })

    expect(original.stockItems[0]!.batches).toEqual([])
  })
})

describe("buildTallyStockSheet", () => {
  it("lists every item with stock, prefilled with the quantity it opens with", () => {
    const document = documentWith([
      item("Panadol 500mg", { openingQuantity: 24, openingValue: 12000, closingQuantity: 30 }),
      item("Amoxil 250mg", { openingQuantity: 0, openingValue: 0 }),
      item("Zinc 20mg", { openingQuantity: 10, openingValue: 5000, closingQuantity: 4 }),
    ])

    const sheet = readTallyStockSheet(new Uint8Array(buildTallyStockSheet(document, "opening")))
    expect(sheet.rows.map((row) => [row.item, row.quantity, row.amount])).toEqual([
      ["Panadol 500mg", 24, 12000],
      ["Zinc 20mg", 10, 5000],
    ])

    const closing = readTallyStockSheet(new Uint8Array(buildTallyStockSheet(document, "closing")))
    expect(closing.rows.map((row) => [row.item, row.quantity])).toEqual([
      ["Panadol 500mg", 30],
      ["Zinc 20mg", 4],
    ])
  })
})
