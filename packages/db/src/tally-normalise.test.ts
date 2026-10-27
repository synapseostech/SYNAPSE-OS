import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { normaliseTallyDocument } from "./tally-normalise.ts"
import { parseTallyXmlRows } from "./tally-xml-rows.ts"

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
    <GROUP NAME="Sundry Debtors" />
    <GROUP NAME="Sundry Creditors" />
    <GROUP NAME="Capital Account" />
    <GROUP NAME="Sales Accounts" />
    <GROUP NAME="Purchase Accounts" />
    <GROUP NAME="Duties and Taxes" />
    ${inner}
  </TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`
}

function plan(inner: string, options = {}) {
  return normaliseTallyDocument(parseTallyXmlRows(tallyExport(inner)), options)
}

const balancedMasters = `
  <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>1000.00</OPENINGBALANCE></LEDGER>
  <LEDGER NAME="Inventory"><PARENT>Current Assets</PARENT><OPENINGBALANCE>12000.00</OPENINGBALANCE></LEDGER>
  <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-13000.00</OPENINGBALANCE></LEDGER>
  <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
  <LEDGER NAME="Purchases"><PARENT>Purchase Accounts</PARENT></LEDGER>
  <LEDGER NAME="Output VAT"><PARENT>Duties and Taxes</PARENT></LEDGER>
  <LEDGER NAME="Test Customer A"><PARENT>Sundry Debtors</PARENT></LEDGER>
  <LEDGER NAME="Test Supplier A"><PARENT>Sundry Creditors</PARENT></LEDGER>
  <STOCKITEM NAME="Test Item A">
    <PARENT>Test Group</PARENT>
    <BASEUNITS>Strip</BASEUNITS>
    <OPENINGBALANCE>12 Strip</OPENINGBALANCE>
    <OPENINGRATE>1000.00</OPENINGRATE>
    <OPENINGVALUE>12000.00</OPENINGVALUE>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>B-001</BATCHNAME>
      <EXPIRYDATE>20270228</EXPIRYDATE>
      <ACTUALQTY>12 Strip</ACTUALQTY>
      <AMOUNT>12000.00</AMOUNT>
    </BATCHALLOCATIONS.LIST>
  </STOCKITEM>
`

describe("normaliseTallyDocument", () => {
  it("builds a balanced opening journal and a posted cash sale from Tally rows", () => {
    const result = plan(`
      ${balancedMasters}
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <GUID>sale-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>S-001</VOUCHERNUMBER>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
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
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Sales</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>-450.00</AMOUNT>
            </LEDGERENTRIES.LIST>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
    `)

    assert.equal(result.company, "Test Pharmacy")
    assert.equal(result.companyKey, "company-guid")
    assert.equal(result.conversionDate, "2026-01-01")
    assert.equal(result.opening.difference, 0)
    const capitalCode = result.accounts.find((account) => account.sourceName === "Capital")!.code
    assert.deepEqual(result.opening.lines.map((line) => [line.accountCode, line.debit, line.credit]), [
      ["1000", 1000, 0],
      ["1200", 12000, 0],
      [capitalCode, 0, 13000],
    ])
    assert.equal(result.counts.postedVouchers, 1)
    assert.equal(result.counts.skippedVouchers, 0)
    assert.equal(result.vouchers[0].sourceId, "company-guid:sale-guid")
    assert.equal(result.vouchers[0].sourceType, "tally_sale")
    assert.equal(result.vouchers[0].lines.length, 3)

    assert.equal(result.sales.length, 1)
    assert.equal(result.sales[0].paymentMethod, "CASH")
    assert.equal(result.sales[0].total, 450)
    assert.equal(result.sales[0].tax, 50)
    assert.deepEqual(result.sales[0].items, [
      { stockItemName: "Test Item A", quantity: 2, unitPrice: 225, lineTotal: 450 },
    ])
    assert.ok(result.exceptions.some((entry) => entry.code === "COST_UNKNOWN"))

    assert.equal(result.stockItems.length, 1)
    assert.equal(result.stockItems[0].quantity, 12)
    assert.equal(result.stockItems[0].batches[0].expiryDate, "2027-02-28")
  })

  it("never plugs an unbalanced opening", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>100.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-90.00</OPENINGBALANCE></LEDGER>
    `)

    assert.equal(result.opening.totalDebit, 100)
    assert.equal(result.opening.totalCredit, 90)
    assert.equal(result.opening.difference, 10)
    assert.equal(result.opening.lines.length, 2)
    const blocking = result.exceptions.filter((entry) => entry.severity === "blocking")
    assert.deepEqual(blocking.map((entry) => entry.code), ["OPENING_DIFFERENCE"])
  })

  it("skips vouchers dated before the cut-over instead of double counting them", () => {
    const result = plan(
      `
        <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>100.00</OPENINGBALANCE></LEDGER>
        <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-100.00</OPENINGBALANCE></LEDGER>
        <VOUCHER VCHTYPE="Journal">
          <GUID>old-guid</GUID>
          <DATE>20251231</DATE>
          <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>10</AMOUNT></LEDGERENTRIES.LIST>
          <LEDGERENTRIES.LIST><LEDGERNAME>Capital</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-10</AMOUNT></LEDGERENTRIES.LIST>
        </VOUCHER>
      `,
      { conversionDate: "2026-01-01" },
    )

    assert.equal(result.counts.postedVouchers, 0)
    assert.equal(result.counts.skippedVouchers, 1)
    assert.ok(result.exceptions.some((entry) => entry.code === "VOUCHER_BEFORE_CONVERSION"))
  })

  it("skips an unbalanced voucher and does not mirror it", () => {
    const result = plan(`
      ${balancedMasters}
      <VOUCHER VCHTYPE="Sales">
        <GUID>bad-guid</GUID>
        <DATE>20260115</DATE>
        <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-90</AMOUNT></LEDGERENTRIES.LIST>
      </VOUCHER>
    `)

    assert.equal(result.counts.postedVouchers, 0)
    assert.equal(result.sales.length, 0)
    assert.ok(result.exceptions.some((entry) => entry.code === "VOUCHER_UNBALANCED"))
  })

  it("keeps a credit sale in the ledger and lists it instead of inventing a payment method", () => {
    const result = plan(`
      ${balancedMasters}
      <VOUCHER VCHTYPE="Sales">
        <GUID>credit-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>S-002</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Test Customer A</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST><LEDGERNAME>Test Customer A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>450</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-450</AMOUNT></LEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>1 Strip</ACTUALQTY>
          <RATE>450</RATE>
          <AMOUNT>450</AMOUNT>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
    `)

    assert.equal(result.counts.postedVouchers, 1)
    assert.equal(result.sales.length, 0)
    assert.ok(result.exceptions.some((entry) => entry.code === "CREDIT_SALE_NOT_MIRRORED"))
  })

  it("mirrors a credit purchase as payable without inventing an amount paid", () => {
    const result = plan(`
      ${balancedMasters}
      <VOUCHER VCHTYPE="Purchase">
        <GUID>purchase-guid</GUID>
        <DATE>20260120</DATE>
        <VOUCHERNUMBER>P-001</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Test Supplier A</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST><LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>300</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Test Supplier A</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-300</AMOUNT></LEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>3 Strip</ACTUALQTY>
          <RATE>100</RATE>
          <AMOUNT>300</AMOUNT>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
    `)

    assert.equal(result.purchases.length, 1)
    assert.equal(result.purchases[0].partyName, "Test Supplier A")
    assert.equal(result.purchases[0].total, 300)
    assert.equal(result.purchases[0].amountPaid, 0)
    assert.equal(result.purchases[0].paymentMethod, undefined)
    assert.equal(result.purchases[0].purchaseNumber, "TALLY-P-001")
  })

  it("derives a missing opening balance from the closing balance and period movements", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSEBALANCE>1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><CLOSEBALANCE>-1000.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT><CLOSEBALANCE>-200.00</CLOSEBALANCE></LEDGER>
      <VOUCHER VCHTYPE="Journal">
        <GUID>movement-guid</GUID>
        <DATE>20260102</DATE>
        <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>200</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-200</AMOUNT></LEDGERENTRIES.LIST>
      </VOUCHER>
    `)

    const cash = result.accounts.find((account) => account.sourceName === "Cash")!
    const capital = result.accounts.find((account) => account.sourceName === "Capital")!
    assert.equal(cash.openingMethod, "derived")
    assert.equal(cash.openingBalance, 1000)
    assert.equal(cash.openingSide, "debit")
    assert.equal(capital.openingBalance, 1000)
    assert.equal(capital.openingSide, "credit")
    assert.equal(result.opening.difference, 0)
  })

  it("flags opening stock without an expiry and never creates an expiring batch for it", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>500.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Inventory"><PARENT>Current Assets</PARENT><OPENINGBALANCE>500.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-1000.00</OPENINGBALANCE></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <OPENINGBALANCE>5 Strip</OPENINGBALANCE>
        <OPENINGRATE>100.00</OPENINGRATE>
        <OPENINGVALUE>500.00</OPENINGVALUE>
      </STOCKITEM>
    `)

    assert.equal(result.opening.difference, 0)
    assert.equal(result.stockItems[0].quantity, 5)
    assert.equal(result.stockItems[0].batches.length, 0)
    assert.ok(result.exceptions.some((entry) => entry.code === "OPENING_STOCK_WITHOUT_EXPIRY"))
  })

  it("flags stock whose batches do not add up and non-whole opening quantities", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>100.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-100.00</OPENINGBALANCE></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <OPENINGBALANCE>2.5 Strip</OPENINGBALANCE>
        <OPENINGRATE>100.00</OPENINGRATE>
        <OPENINGVALUE>250.00</OPENINGVALUE>
        <BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-001</BATCHNAME>
          <EXPIRYDATE>20270228</EXPIRYDATE>
          <ACTUALQTY>2 Strip</ACTUALQTY>
          <AMOUNT>200.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
      </STOCKITEM>
    `)

    const codes = result.exceptions.map((entry) => entry.code)
    assert.ok(codes.includes("NON_INTEGER_QUANTITY"))
    assert.ok(codes.includes("OPENING_STOCK_QUANTITY_MISMATCH"))
  })

  it("marks expired opening batches as not receivable and reports them once", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>1200.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Inventory"><PARENT>Current Assets</PARENT><OPENINGBALANCE>600.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-1800.00</OPENINGBALANCE></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <OPENINGBALANCE>6 Strip</OPENINGBALANCE>
        <OPENINGRATE>100.00</OPENINGRATE>
        <OPENINGVALUE>600.00</OPENINGVALUE>
        <BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-OLD</BATCHNAME>
          <EXPIRYDATE>20250228</EXPIRYDATE>
          <ACTUALQTY>3 Strip</ACTUALQTY>
          <AMOUNT>300.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
        <BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-NEW</BATCHNAME>
          <EXPIRYDATE>20270228</EXPIRYDATE>
          <ACTUALQTY>3 Strip</ACTUALQTY>
          <AMOUNT>300.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
      </STOCKITEM>
    `,
      { today: "2026-04-01" },
    )

    const batches = result.stockItems[0].batches
    assert.equal(batches.length, 2)
    assert.equal(batches[0].receivable, false)
    assert.equal(batches[1].receivable, true)

    const expired = result.exceptions.filter((entry) => entry.code === "OPENING_STOCK_EXPIRED")
    assert.equal(expired.length, 1)
    assert.match(expired[0].message, /3 units/)
    assert.equal(result.opening.difference, 0)
  })

  it("uses a stable content identity when Tally exports no voucher GUID", () => {
    const inner = `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>100.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-100.00</OPENINGBALANCE></LEDGER>
      <VOUCHER VCHTYPE="Journal">
        <DATE>20260102</DATE>
        <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>10</AMOUNT></LEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>Capital</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-10</AMOUNT></LEDGERENTRIES.LIST>
      </VOUCHER>
    `
    const first = plan(inner)
    const second = plan(inner)

    assert.match(first.vouchers[0].sourceId, /^company-guid:H-[0-9A-F]{8}$/)
    assert.equal(first.vouchers[0].sourceId, second.vouchers[0].sourceId)
    assert.ok(first.exceptions.some((entry) => entry.code === "VOUCHER_GUID_MISSING"))
  })

  it("flags close balances that cannot be converted without a period-start cut-over", () => {
    const result = plan(
      `
        <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSEBALANCE>500.00</CLOSEBALANCE></LEDGER>
      `,
      { conversionDate: "2026-06-30" },
    )

    assert.equal(result.accounts[0].openingMethod, "none")
    assert.ok(result.exceptions.some((entry) => entry.code === "OPENING_BALANCE_UNAVAILABLE"))
  })

  it("rejects an invalid conversion date", () => {
    assert.throws(
      () => normaliseTallyDocument(parseTallyXmlRows(tallyExport("")), { conversionDate: "31/01/2026" }),
      /TALLY_CONVERSION_DATE_REQUIRED/,
    )
  })

  it("creates party bills with due dates derived only from Tally's credit period", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>700.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-1400.00</OPENINGBALANCE></LEDGER>
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
    `)

    const customer = result.parties.find((party) => party.name === "Test Customer A")!
    assert.equal(customer.kind, "customer")
    assert.deepEqual(customer.bills, [
      { reference: "INV-1", amount: 700, dueDate: "2026-01-31", billType: "New Ref", dueDateDerived: true },
    ])
    assert.equal(result.opening.difference, 0)
  })
})
