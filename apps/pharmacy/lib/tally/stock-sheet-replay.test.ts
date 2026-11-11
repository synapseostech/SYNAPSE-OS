/**
 * The StockBatches sheet, end to end.
 *
 * SADIO's masters export carries no batch allocation and no expiry on stock
 * items, so replay opens from empty shelves and every sale is a shortfall. The
 * agreed remedy is an operator-supplied sheet: this proves that filling it
 * turns the exported opening position into receivable batches and that replay
 * then reconciles against Tally's own closing figures.
 *
 * Every value here is invented. No customer data is used.
 */

import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import { reconcileReplay, simulateReplay } from "@synapse/db/tally-replay"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import { consolidateTallyParts } from "./consolidate"
import { readTallyDocument } from "./source"
import { applyTallyStockSheet, buildTallyStockSheet, readTallyStockSheet } from "./stock-sheet"

const COMPANY = "ZZ Sheet Replay Pharmacy"
const ITEM = "ZZ Sheet Amoxicillin"
const FIRST = "2025-10-01"
const CUTOFF = "2026-11-30"
const BATCH = "B-2401"
const EXPIRY = "2027-03-31"

function envelope(inner: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ENVELOPE>",
    "  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>",
    "  <BODY><DATA>",
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    inner,
    "    </TALLYMESSAGE>",
    "  </DATA></BODY>",
    "</ENVELOPE>",
  ].join("\n")
}

function companyBlock(from: string, to: string): string {
  return [
    "      <COMPANY>",
    `        <COMPANYNAME>${COMPANY}</COMPANYNAME>`,
    "        <GUID>4b000000-0000-4000-8000-000000000001</GUID>",
    "        <CURRENCYNAME>UGX</CURRENCYNAME>",
    `        <SVFROMDATE>${from.replace(/-/g, "")}</SVFROMDATE>`,
    `        <SVTODATE>${to.replace(/-/g, "")}</SVTODATE>`,
    "      </COMPANY>",
  ].join("\n")
}

function ledger(name: string, parent: string, closing: number): string {
  return [
    `      <LEDGER NAME="${name}">`,
    `        <PARENT>${parent}</PARENT>`,
    "        <OPENINGBALANCE>0.00</OPENINGBALANCE>",
    `        <CLOSINGBALANCE>${closing.toFixed(2)}</CLOSINGBALANCE>`,
    "      </LEDGER>",
  ].join("\n")
}

/**
 * Masters as this Tally build writes them: opening and closing quantity and
 * value, no batch allocation, no expiry flags.
 */
function mastersXml(): string {
  return envelope(
    [
      companyBlock(FIRST, CUTOFF),
      ...["Current Assets", "Cash-in-Hand", "Sales Accounts"].map(
        (group) => `      <GROUP NAME="${group}"/>`,
      ),
      ledger("Cash-in-hand", "Cash-in-Hand", 800),
      ledger("Sales Accounts", "Sales Accounts", -800),
      '      <UNIT NAME="Strip"><SYMBOL>strip</SYMBOL></UNIT>',
      `      <STOCKITEM NAME="${ITEM}">`,
      "        <PARENT>Primary</PARENT>",
      "        <BASEUNITS>Strip</BASEUNITS>",
      "        <OPENINGBALANCE>20 Strip</OPENINGBALANCE>",
      "        <OPENINGRATE>100.00</OPENINGRATE>",
      "        <OPENINGVALUE>2000.00</OPENINGVALUE>",
      "        <CLOSINGBALANCE>12 Strip</CLOSINGBALANCE>",
      "        <CLOSINGVALUE>1200.00</CLOSINGVALUE>",
      "      </STOCKITEM>",
    ].join("\n"),
  )
}

/** 8 units sold at 100.00 on 2026-10-05, after the opening date. */
function dayBookXml(): string {
  return envelope(
    [
      companyBlock(FIRST, CUTOFF),
      `      <VOUCHER VCHTYPE="Cash Sale" GUID="4b000000-0000-4000-8000-000000000101">`,
      "        <DATE>20261005</DATE>",
      "        <GUID>4b000000-0000-4000-8000-000000000101</GUID>",
      "        <VOUCHERNUMBER>SAL-0001</VOUCHERNUMBER>",
      "        <PARTYLEDGERNAME>Cash-in-hand</PARTYLEDGERNAME>",
      "        <ALLLEDGERENTRIES.LIST>",
      "          <LEDGERNAME>Cash-in-hand</LEDGERNAME>",
      "          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>",
      "          <AMOUNT>800.00</AMOUNT>",
      "        </ALLLEDGERENTRIES.LIST>",
      "        <ALLLEDGERENTRIES.LIST>",
      "          <LEDGERNAME>Sales Accounts</LEDGERNAME>",
      "          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
      "          <AMOUNT>-800.00</AMOUNT>",
      "        </ALLLEDGERENTRIES.LIST>",
      "        <ALLINVENTORYENTRIES.LIST>",
      `          <STOCKITEMNAME>${ITEM}</STOCKITEMNAME>`,
      "          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
      "          <RATE>100.00/Strip</RATE>",
      "          <AMOUNT>-800.00</AMOUNT>",
      "          <ACTUALQTY>8 Strip</ACTUALQTY>",
      "        </ALLINVENTORYENTRIES.LIST>",
      "      </VOUCHER>",
    ].join("\n"),
  )
}

function consolidated(): TallyXmlDocument {
  const parts = [
    ["2-masters-20251001-20261130.xml", mastersXml()],
    ["3-daybook-20251001-20261130.xml", dayBookXml()],
  ].map(([name, xml]) => readTallyDocument(new TextEncoder().encode(xml), name!).document)
  return consolidateTallyParts(parts, {
    period: { from: FIRST, to: CUTOFF },
    company: COMPANY,
  }).document
}

function replayPlan(document: TallyXmlDocument) {
  return normaliseTallyDocument(document, { mode: "replay", today: CUTOFF })
}

function stockRow(reconciliation: ReturnType<typeof reconcileReplay>, key: string) {
  return reconciliation.rows.find((row) => row.scope === "stock_item" && row.key === key)
}

describe("stock sheet to replay", () => {
  it("shows the exported masters alone open from empty shelves", () => {
    const plan = replayPlan(consolidated())

    expect(plan.stockItems[0]).toMatchObject({
      sourceName: ITEM,
      quantity: 20,
      value: 2000,
      closingQuantity: 12,
      batches: [],
    })
    expect(plan.exceptions.map((entry) => entry.code)).toContain("OPENING_STOCK_WITHOUT_EXPIRY")

    const reconciliation = reconcileReplay(simulateReplay(plan), plan)
    // The 8-unit sale cannot come from an opening position that was never
    // received, so the shelf goes negative and the row cannot reconcile.
    expect(stockRow(reconciliation, ITEM)).toMatchObject({
      expected: 12,
      actual: -8,
      status: "difference",
    })
    expect(reconciliation.blocking).toBeGreaterThan(0)
  })

  it("makes the opening position receivable once the sheet states a batch and expiry", () => {
    const exported = consolidated()

    // What the operator downloads: the item, its opening quantity and value,
    // with the batch and expiry left blank because the export does not hold them.
    const downloaded = readTallyStockSheet(new Uint8Array(buildTallyStockSheet(exported, "opening")))
    expect(downloaded.rows).toEqual([{ row: 2, item: ITEM, quantity: 20, amount: 2000 }])
    // Blank by design: the sheet asks, it does not guess. Returned as-is it
    // would create no batch, and the reader says so.
    expect(downloaded.problems).toEqual(["1 row has no expiry, so it creates no batch."])

    // What they return: the same row with a batch name and expiry typed in.
    const row = downloaded.rows[0]!
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["stock_item", "batch", "expiry", "quantity", "amount", "godown"],
        [row.item, BATCH, EXPIRY, row.quantity, row.amount, ""],
      ]),
      "StockBatches",
    )
    const filled = readTallyStockSheet(
      new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
    )
    expect(filled.problems).toEqual([])

    const merge = applyTallyStockSheet(exported, filled)
    expect(merge).toMatchObject({ applied: 1, unmatched: [], withoutExpiry: 0 })

    const plan = replayPlan(merge.document)
    expect(plan.stockItems[0]?.batches).toEqual([
      { batchName: BATCH, expiryDate: EXPIRY, quantity: 20, receivable: true },
    ])
    expect(plan.exceptions.map((entry) => entry.code)).not.toContain("OPENING_STOCK_WITHOUT_EXPIRY")

    const reconciliation = reconcileReplay(simulateReplay(plan), plan)
    expect(reconciliation.blocking).toBe(0)
    expect(stockRow(reconciliation, ITEM)).toMatchObject({
      expected: 12,
      actual: 12,
      status: "match",
    })
    expect(stockRow(reconciliation, `${ITEM} (value)`)).toMatchObject({
      expected: 1200,
      actual: 1200,
      status: "match",
    })
    expect(
      reconciliation.rows.find((entry) => entry.scope === "stock_total"),
    ).toMatchObject({ expected: 1200, actual: 1200, status: "match" })
    expect(
      reconciliation.rows
        .filter((entry) => entry.scope === "account" && entry.status !== "match")
        .map((entry) => entry.key),
    ).toEqual([])
  })
})
