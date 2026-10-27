import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parseTallyAmount,
  parseTallyRowDate,
  parseTallyXmlRows,
  TALLY_XML_ROW_LIMITS,
} from "./tally-xml-rows.ts"

function tallyExport(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`
}

describe("parseTallyXmlRows", () => {
  it("reads company identity, groups, ledgers and stock masters", () => {
    const document = parseTallyXmlRows(
      tallyExport(`
        <COMPANY>
          <COMPANYNAME>Test Pharmacy</COMPANYNAME>
          <GUID>company-guid</GUID>
          <CURRENCYNAME>UGX</CURRENCYNAME>
          <SVFROMDATE>20260101</SVFROMDATE>
          <SVTODATE>20261231</SVTODATE>
        </COMPANY>
        <GROUP NAME="Cash-in-hand"><PARENT>Current Assets</PARENT></GROUP>
        <LEDGER NAME="Cash">
          <PARENT>Cash-in-hand</PARENT>
          <OPENINGBALANCE>1,250.50</OPENINGBALANCE>
          <CLOSEBALANCE>-250.25</CLOSEBALANCE>
          <EMAIL>counter@example.com</EMAIL>
          <ADDRESS.LIST><ADDRESS>Plot 1</ADDRESS><ADDRESS>Kampala</ADDRESS></ADDRESS.LIST>
        </LEDGER>
        <STOCKITEM NAME="Test Item A">
          <PARENT>Test Group</PARENT>
          <BASEUNITS>Strip</BASEUNITS>
          <OPENINGBALANCE>12 Strip</OPENINGBALANCE>
          <OPENINGRATE>1,000.00</OPENINGRATE>
          <OPENINGVALUE>12000</OPENINGVALUE>
          <ISBATCHWISEON>Yes</ISBATCHWISEON>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-001</BATCHNAME>
            <EXPIRYDATE>20270228</EXPIRYDATE>
            <ACTUALQTY>12 Strip</ACTUALQTY>
            <AMOUNT>12000</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </STOCKITEM>
      `),
      "tally.xml",
    )

    assert.equal(document.company, "Test Pharmacy")
    assert.equal(document.companyGuid, "company-guid")
    assert.equal(document.currency, "UGX")
    assert.deepEqual(document.financialPeriod, { from: "2026-01-01", to: "2026-12-31" })
    assert.equal(document.groups.length, 1)
    assert.equal(document.groups[0].name, "Cash-in-hand")
    assert.equal(document.groups[0].parent, "Current Assets")

    assert.equal(document.ledgers.length, 1)
    const cash = document.ledgers[0]
    assert.equal(cash.name, "Cash")
    assert.equal(cash.openingBalance, 1250.5)
    assert.equal(cash.closingBalance, -250.25)
    assert.equal(cash.email, "counter@example.com")
    assert.equal(cash.address, "Plot 1, Kampala")

    assert.equal(document.stockItems.length, 1)
    const item = document.stockItems[0]
    assert.equal(item.name, "Test Item A")
    assert.equal(item.baseUnit, "Strip")
    assert.equal(item.openingQuantity, 12)
    assert.equal(item.openingRate, 1000)
    assert.equal(item.openingValue, 12000)
    assert.equal(item.batchWise, true)
    assert.deepEqual(item.batches, [
      { batchName: "B-001", expiryDate: "2027-02-28", quantity: 12, amount: 12000, godown: undefined },
    ])
    assert.deepEqual(document.warnings, [])
  })

  it("reads a voucher's party, tax and inventory lines without losing the accounting side", () => {
    const document = parseTallyXmlRows(
      tallyExport(`
        <VOUCHER VCHTYPE="Sales" ACTION="Create">
          <GUID>voucher-guid</GUID>
          <DATE>20260214</DATE>
          <VOUCHERNUMBER>S-001</VOUCHERNUMBER>
          <NARRATION>Counter sale</NARRATION>
          <PARTYLEDGERNAME>Test Customer A</PARTYLEDGERNAME>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>Test Customer A</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>500.00</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>Output VAT</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>-50.00</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
            <ACTUALQTY>2 Strip</ACTUALQTY>
            <RATE>225.00/Strip</RATE>
            <AMOUNT>450.00</AMOUNT>
            <BATCHALLOCATIONS.LIST>
              <BATCHNAME>B-001</BATCHNAME>
              <EXPIRYDATE>20270228</EXPIRYDATE>
              <ACTUALQTY>2 Strip</ACTUALQTY>
              <AMOUNT>450.00</AMOUNT>
            </BATCHALLOCATIONS.LIST>
            <ACCOUNTINGALLOCATIONS.LIST>
              <LEDGERENTRIES.LIST>
                <LEDGERNAME>Sales</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>-450.00</AMOUNT>
              </LEDGERENTRIES.LIST>
            </ACCOUNTINGALLOCATIONS.LIST>
          </ALLINVENTORYENTRIES.LIST>
        </VOUCHER>
      `),
      "tally.xml",
    )

    assert.equal(document.vouchers.length, 1)
    const voucher = document.vouchers[0]
    assert.equal(voucher.guid, "voucher-guid")
    assert.equal(voucher.type, "Sales")
    assert.equal(voucher.number, "S-001")
    assert.equal(voucher.date, "2026-02-14")
    assert.equal(voucher.partyLedgerName, "Test Customer A")
    assert.equal(voucher.isCancelled, false)

    assert.deepEqual(
      voucher.ledgerLines.map((line) => [line.ledgerName, line.side, line.amount]),
      [
        ["Test Customer A", "debit", 500],
        ["Output VAT", "credit", 50],
      ],
    )

    assert.equal(voucher.inventoryLines.length, 1)
    const inventory = voucher.inventoryLines[0]
    assert.equal(inventory.stockItemName, "Test Item A")
    assert.equal(inventory.quantity, 2)
    assert.equal(inventory.rate, 225)
    assert.equal(inventory.amount, 450)
    assert.equal(inventory.batches[0].expiryDate, "2027-02-28")
    assert.deepEqual(
      inventory.ledgers.map((line) => [line.ledgerName, line.side, line.amount]),
      [["Sales", "credit", 450]],
    )
  })

  it("derives the ledger side from the amount sign when ISDEEMEDPOSITIVE is absent", () => {
    const document = parseTallyXmlRows(
      tallyExport(`
        <VOUCHER VCHTYPE="Receipt"><DATE>20260102</DATE>
          <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>100</AMOUNT></LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST><LEDGERNAME>Test Customer A</LEDGERNAME><AMOUNT>-100</AMOUNT></LEDGERENTRIES.LIST>
        </VOUCHER>
      `),
    )

    assert.deepEqual(
      document.vouchers[0].ledgerLines.map((line) => [line.ledgerName, line.side, line.amount]),
      [
        ["Cash", "debit", 100],
        ["Test Customer A", "credit", 100],
      ],
    )
  })

  it("reads bill allocations on a party ledger", () => {
    const document = parseTallyXmlRows(
      tallyExport(`
        <LEDGER NAME="Test Customer A">
          <PARENT>Sundry Debtors</PARENT>
          <OPENINGBALANCE>700.00</OPENINGBALANCE>
          <BILLALLOCATIONS.LIST>
            <NAME>INV-1</NAME>
            <BILLTYPE>New Ref</BILLTYPE>
            <AMOUNT>700.00</AMOUNT>
            <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
          </BILLALLOCATIONS.LIST>
        </LEDGER>
      `),
    )

    assert.deepEqual(document.ledgers[0].bills, [
      { name: "INV-1", billType: "New Ref", amount: 700, creditPeriodDays: 30 },
    ])
  })

  it("marks cancelled vouchers without dropping their data", () => {
    const document = parseTallyXmlRows(
      tallyExport(`<VOUCHER VCHTYPE="Sales"><DATE>20260101</DATE><ISCANCELLED>Yes</ISCANCELLED></VOUCHER>`),
    )
    assert.equal(document.vouchers[0].isCancelled, true)
  })

  it("accepts a comment containing a declaration and rejects a real declaration", () => {
    const withComment = parseTallyXmlRows(
      `<!-- generated <! not a doctype > --><ENVELOPE><BODY><DATA><TALLYMESSAGE><LEDGER NAME="Cash" /></TALLYMESSAGE></DATA></BODY></ENVELOPE>`,
    )
    assert.equal(withComment.ledgers.length, 1)

    assert.throws(
      () => parseTallyXmlRows(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ENVELOPE/>`),
      /MIGRATION_XML_ENTITIES_REJECTED/,
    )
  })

  it("rejects empty, non-UTF-8, oversized and tag-flooded input", () => {
    assert.throws(() => parseTallyXmlRows(""), /MIGRATION_EMPTY_FILE/)
    assert.throws(() => parseTallyXmlRows(new Uint8Array([0xff, 0xfe, 0x00])), /MIGRATION_XML_NOT_UTF8/)
    assert.throws(
      () => parseTallyXmlRows(`<ENVELOPE>${"x".repeat(TALLY_XML_ROW_LIMITS.MAX_BYTES)}</ENVELOPE>`),
      /MIGRATION_FILE_TOO_LARGE/,
    )
    assert.throws(
      () => parseTallyXmlRows(`<ENVELOPE>${"<a>".repeat(TALLY_XML_ROW_LIMITS.MAX_TAGS + 1)}</ENVELOPE>`),
      /MIGRATION_XML_TOO_COMPLEX/,
    )
  })

  it("bounds captured text and warns instead of throwing on unreadable values", () => {
    const document = parseTallyXmlRows(
      tallyExport(`
        <LEDGER NAME="Cash">
          <PARENT>Cash-in-hand</PARENT>
          <OPENINGBALANCE>not-a-number</OPENINGBALANCE>
          <ADDRESS.LIST><ADDRESS>${"A".repeat(TALLY_XML_ROW_LIMITS.MAX_TEXT + 100)}</ADDRESS></ADDRESS.LIST>
        </LEDGER>
        <VOUCHER VCHTYPE="Sales"><DATE>20261301</DATE></VOUCHER>
      `),
    )

    assert.equal(document.ledgers[0].openingBalance, undefined)
    assert.ok((document.ledgers[0].address ?? "").length <= TALLY_XML_ROW_LIMITS.MAX_TEXT)
    assert.equal(document.vouchers[0].date, undefined)
    assert.ok(document.warnings.includes("AMOUNT_UNREADABLE"))
    assert.ok(document.warnings.includes("DATE_UNREADABLE"))
  })

  it("scans hostile whitespace and identifier runs in linear time", () => {
    const started = Date.now()
    // Both shapes backtrack quadratically against an unbounded, overlapping scan.
    assert.deepEqual(parseTallyXmlRows(`<ENVELOPE><${" ".repeat(200_000)}`).ledgers, [])
    assert.equal(
      parseTallyXmlRows(`<ENVELOPE><LEDGER ${"A".repeat(200_000)}></LEDGER></ENVELOPE>`).ledgers.length,
      1,
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2_000, `hostile input took ${elapsed}ms`)
  })

  it("reads self-closing records", () => {
    const document = parseTallyXmlRows(tallyExport(`<LEDGER NAME="Self closing" />`))
    assert.equal(document.ledgers.length, 1)
    assert.equal(document.ledgers[0].name, "Self closing")
  })
})

describe("parseTallyRowDate", () => {
  it("accepts Tally and ISO dates and rejects impossible calendar dates", () => {
    assert.equal(parseTallyRowDate("20260228"), "2026-02-28")
    assert.equal(parseTallyRowDate("2026-02-28"), "2026-02-28")
    assert.equal(parseTallyRowDate("20260230"), undefined)
    assert.equal(parseTallyRowDate("2026-2-3"), undefined)
    assert.equal(parseTallyRowDate(undefined), undefined)
  })
})

describe("parseTallyAmount", () => {
  it("parses decimal strings through minor units without float drift", () => {
    assert.equal(parseTallyAmount("1,250.50"), 1250.5)
    assert.equal(parseTallyAmount("-0.05"), -0.05)
    assert.equal(parseTallyAmount("10.005"), 10.01)
    assert.equal(parseTallyAmount("10.004"), 10)
    assert.equal(parseTallyAmount("+7"), 7)
    assert.equal(parseTallyAmount(""), undefined)
    assert.equal(parseTallyAmount("12abc"), undefined)
    assert.equal(parseTallyAmount(undefined), undefined)
  })
})
