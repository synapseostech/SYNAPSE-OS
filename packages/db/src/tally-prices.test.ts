import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { normaliseTallyDocument } from "./tally-normalise.ts"
import { parseTallyXmlRows } from "./tally-xml-rows.ts"

/**
 * Where an imported product's selling price and cost come from: Tally's own
 * Standard Selling Price / Standard Cost when the master states them, else the
 * latest sales / purchase voucher rate. Every value here is invented.
 */

function tallyExport(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <BODY><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
    <COMPANY>
      <COMPANYNAME>Test Pharmacy</COMPANYNAME>
      <GUID>company-guid</GUID>
      <CURRENCYNAME>UGX</CURRENCYNAME>
      <SVFROMDATE>20260101</SVFROMDATE>
      <SVTODATE>20261231</SVTODATE>
    </COMPANY>
    <GROUP NAME="Current Assets" />
    <GROUP NAME="Cash-in-hand"><PARENT>Current Assets</PARENT></GROUP>
    <GROUP NAME="Sundry Creditors" />
    <GROUP NAME="Capital Account" />
    <GROUP NAME="Sales Accounts" />
    <GROUP NAME="Purchase Accounts" />
    <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>1000.00</OPENINGBALANCE></LEDGER>
    <LEDGER NAME="Inventory"><PARENT>Current Assets</PARENT><OPENINGBALANCE>12000.00</OPENINGBALANCE></LEDGER>
    <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-13000.00</OPENINGBALANCE></LEDGER>
    <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
    <LEDGER NAME="Purchases"><PARENT>Purchase Accounts</PARENT></LEDGER>
    <LEDGER NAME="Test Supplier A"><PARENT>Sundry Creditors</PARENT></LEDGER>
    ${inner}
  </TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`
}

function itemXml(name: string, extra = ""): string {
  return `
  <STOCKITEM NAME="${name}">
    <PARENT>Test Group</PARENT>
    <BASEUNITS>Strip</BASEUNITS>
    <OPENINGBALANCE>12 Strip</OPENINGBALANCE>
    <OPENINGRATE>500.00/Strip</OPENINGRATE>
    <OPENINGVALUE>6000.00</OPENINGVALUE>
    ${extra}
  </STOCKITEM>`
}

function sale(guid: string, date: string, itemName: string, rate: number): string {
  return `
  <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <GUID>${guid}</GUID>
    <DATE>${date}</DATE>
    <VOUCHERNUMBER>${guid}</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Cash</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${rate * 2}.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
      <ACTUALQTY>2 Strip</ACTUALQTY>
      <RATE>${rate}.00/Strip</RATE>
      <AMOUNT>${rate * 2}.00</AMOUNT>
      <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>Sales</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${rate * 2}.00</AMOUNT>
        </LEDGERENTRIES.LIST>
      </ACCOUNTINGALLOCATIONS.LIST>
    </ALLINVENTORYENTRIES.LIST>
  </VOUCHER>`
}

function purchase(guid: string, date: string, itemName: string, rate: number): string {
  return `
  <VOUCHER VCHTYPE="Purchase" ACTION="Create">
    <GUID>${guid}</GUID>
    <DATE>${date}</DATE>
    <VOUCHERNUMBER>${guid}</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Test Supplier A</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Test Supplier A</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${rate * 10}.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
      <ACTUALQTY>10 Strip</ACTUALQTY>
      <RATE>${rate}.00/Strip</RATE>
      <AMOUNT>-${rate * 10}.00</AMOUNT>
      <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>Purchases</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-${rate * 10}.00</AMOUNT>
        </LEDGERENTRIES.LIST>
      </ACCOUNTINGALLOCATIONS.LIST>
    </ALLINVENTORYENTRIES.LIST>
  </VOUCHER>`
}

function stockItem(inner: string, name = "Test Item A") {
  const plan = normaliseTallyDocument(parseTallyXmlRows(tallyExport(inner)))
  return { plan, item: plan.stockItems.find((entry) => entry.name === name)! }
}

describe("imported product prices", () => {
  it("sells at the rate on the item's latest sale, not at cost", () => {
    const { item } = stockItem(itemXml("Test Item A") + sale("s1", "20260115", "Test Item A", 700))
    assert.deepEqual(item.sellingPrice, { amount: 700, source: "last-sale", date: "2026-01-15" })
  })

  it("takes the latest sale by date, and on one date the later voucher in the export", () => {
    const { item } = stockItem(
      itemXml("Test Item A") +
        sale("s1", "20260301", "Test Item A", 800) +
        sale("s2", "20260115", "Test Item A", 650) +
        sale("s3", "20260301", "Test Item A", 820),
    )
    assert.deepEqual(item.sellingPrice, { amount: 820, source: "last-sale", date: "2026-03-01" })
  })

  it("costs at the latest purchase rate", () => {
    const { item } = stockItem(
      itemXml("Test Item A") +
        purchase("p1", "20260110", "Test Item A", 520) +
        purchase("p2", "20260220", "Test Item A", 540),
    )
    assert.deepEqual(item.purchaseCost, { amount: 540, source: "last-purchase", date: "2026-02-20" })
  })

  it("prefers Tally's Standard Selling Price and Standard Cost, the latest dated entry of each", () => {
    const lists = `
      <STANDARDPRICELIST.LIST><DATE>20250401</DATE><RATE>750.00/Strip</RATE></STANDARDPRICELIST.LIST>
      <STANDARDPRICELIST.LIST><DATE>20260101</DATE><RATE>900.00/Strip</RATE></STANDARDPRICELIST.LIST>
      <STANDARDCOSTLIST.LIST><DATE>20260101</DATE><RATE>560.00/Strip</RATE></STANDARDCOSTLIST.LIST>`
    const { item } = stockItem(
      itemXml("Test Item A", lists) +
        sale("s1", "20260115", "Test Item A", 700) +
        purchase("p1", "20260110", "Test Item A", 520),
    )
    assert.deepEqual(item.sellingPrice, { amount: 900, source: "standard-price", date: "2026-01-01" })
    assert.deepEqual(item.purchaseCost, { amount: 560, source: "standard-cost", date: "2026-01-01" })
  })

  it("ignores a zero standard price rather than selling the item free", () => {
    const lists = `<STANDARDPRICELIST.LIST><DATE>20260101</DATE><RATE>0.00/Strip</RATE></STANDARDPRICELIST.LIST>`
    const { item } = stockItem(itemXml("Test Item A", lists) + sale("s1", "20260115", "Test Item A", 700))
    assert.equal(item.sellingPrice?.source, "last-sale")
  })

  it("leaves an item with no price anywhere unpriced and names it in a warning", () => {
    const { plan, item } = stockItem(itemXml("Test Item A") + itemXml("Test Item B") + sale("s1", "20260115", "Test Item A", 700), "Test Item B")
    assert.equal(item.sellingPrice, undefined)
    const warning = plan.exceptions.find((entry) => entry.code === "PRICE_FROM_COST")
    assert.ok(warning, "no PRICE_FROM_COST warning")
    assert.equal(warning.severity, "warning")
    assert.match(warning.message, /^1 of 2 stock items/)
    assert.match(warning.message, /Test Item B/)
  })
})

