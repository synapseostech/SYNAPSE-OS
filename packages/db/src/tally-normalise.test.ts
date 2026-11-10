import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { normaliseTallyDocument } from "./tally-normalise.ts"
import { parseTallyXmlRows, TALLY_XML_ROW_LIMITS } from "./tally-xml-rows.ts"

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
      { stockItemName: "Test Item A", quantity: 2, unitPrice: 225, lineTotal: 450, lineIndex: 0 },
    ])
    assert.ok(result.exceptions.some((entry) => entry.code === "COST_UNKNOWN"))

    assert.equal(result.stockItems.length, 1)
    assert.equal(result.stockItems[0].quantity, 12)
    assert.equal(result.stockItems[0].batches[0].expiryDate, "2027-02-28")
  })

  it("mirrors the cash sales and cash purchases a small pharmacy actually exports", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Loan"><PARENT>Capital Account</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="SALES A/C"><PARENT>Sales Accounts</PARENT></LEDGER>
      <LEDGER NAME="Guardian Pharmacy Hoima"><PARENT>Purchase Accounts</PARENT></LEDGER>
      <VOUCHER VCHTYPE="Cash Sale" ACTION="Create">
        <GUID>cash-sale-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>60984.00</AMOUNT>
        </LEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>28 ea</ACTUALQTY>
          <RATE>1500.00/ea</RATE>
          <AMOUNT>42000.00</AMOUNT>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>SALES A/C</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>42000.00</AMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item B</STOCKITEMNAME>
          <ACTUALQTY>28 ea</ACTUALQTY>
          <RATE>678.00/ea</RATE>
          <AMOUNT>18984.00</AMOUNT>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>SALES A/C</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>18984.00</AMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
      <VOUCHER VCHTYPE="Purchase" ACTION="Create">
        <GUID>purchase-guid</GUID>
        <DATE>20260120</DATE>
        <VOUCHERNUMBER>1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>45080.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Guardian Pharmacy Hoima</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-45080.00</AMOUNT>
          <INVENTORYALLOCATIONS.LIST>
            <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
            <ACTUALQTY>280 ea</ACTUALQTY>
            <RATE>161.00/ea</RATE>
            <AMOUNT>-45080.00</AMOUNT>
          </INVENTORYALLOCATIONS.LIST>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    `)

    assert.equal(result.counts.skippedVouchers, 0)
    assert.equal(result.counts.postedVouchers, 2)

    assert.equal(result.sales.length, 1)
    assert.equal(result.sales[0].paymentMethod, "CASH")
    assert.equal(result.sales[0].total, 60984)
    assert.equal(result.sales[0].items.length, 2)

    // Tally writes PARTYLEDGERNAME "Cash" on both vouchers; the ledger line
    // classified as the supplier is the name the purchase belongs to.
    assert.equal(result.purchases.length, 1)
    assert.equal(result.purchases[0].partyName, "Guardian Pharmacy Hoima")
    assert.equal(result.purchases[0].paymentMethod, "CASH")
    assert.equal(result.purchases[0].total, 45080)

    const suppliers = result.parties.filter((party) => party.kind === "supplier")
    assert.deepEqual(suppliers.map((party) => party.name), ["Guardian Pharmacy Hoima"])
  })

  it("classifies a day-book export's ledgers from the side their vouchers use", () => {
    // No ledger masters at all: the export the customer actually has. Cash is
    // still recognised by name; the revenue and supplier ledgers are settled
    // by the side they occupy and reported as inferred.
    const result = plan(`
      <VOUCHER VCHTYPE="Cash Sale" ACTION="Create">
        <GUID>cash-sale-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>42000.00</AMOUNT>
        </LEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>28 ea</ACTUALQTY>
          <RATE>1500.00/ea</RATE>
          <AMOUNT>42000.00</AMOUNT>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>SALES A/C</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>42000.00</AMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
      <VOUCHER VCHTYPE="Purchase" ACTION="Create">
        <GUID>purchase-guid</GUID>
        <DATE>20260120</DATE>
        <VOUCHERNUMBER>1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>45080.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Acme Wholesale</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-45080.00</AMOUNT>
          <INVENTORYALLOCATIONS.LIST>
            <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
            <ACTUALQTY>280 ea</ACTUALQTY>
            <RATE>161.00/ea</RATE>
            <AMOUNT>-45080.00</AMOUNT>
          </INVENTORYALLOCATIONS.LIST>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    `)

    const byName = new Map(result.accounts.map((account) => [account.sourceName, account]))
    assert.equal(byName.get("Cash")!.role, "cash")
    assert.equal(byName.get("SALES A/C")!.role, "sales")
    assert.equal(byName.get("Acme Wholesale")!.role, "expense")
    assert.ok(result.exceptions.some((entry) => entry.code === "LEDGER_INFERRED" && entry.detail === "SALES A/C"))

    assert.equal(result.sales.length, 1)
    assert.equal(result.sales[0].paymentMethod, "CASH")
    assert.equal(result.purchases.length, 1)
    assert.equal(result.purchases[0].partyName, "Acme Wholesale")
    assert.equal(result.purchases[0].paymentMethod, "CASH")
    assert.equal(result.exceptionCounts?.PARTY_INFERRED, 1)
  })

  it("names a stock line the export gave no quantity instead of dropping it", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="SALES A/C"><PARENT>Sales Accounts</PARENT></LEDGER>
      <VOUCHER VCHTYPE="Cash Sale" ACTION="Create">
        <GUID>cash-sale-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
        <LEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>10500.00</AMOUNT>
        </LEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Savlon 200mls</STOCKITEMNAME>
          <ACTUALQTY></ACTUALQTY>
          <RATE>1050.00/ea</RATE>
          <AMOUNT>10500.00</AMOUNT>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>SALES A/C</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>10500.00</AMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
    `)

    assert.equal(result.sales.length, 0)
    const reported = result.exceptions.find((entry) => entry.code === "STOCK_LINE_WITHOUT_QUANTITY")
    assert.ok(reported)
    assert.match(reported!.message, /Savlon 200mls/)
    assert.match(reported!.message, /10500\.00/)
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

  it("posts Tally's own sign, where a debit balance is negative", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSINGBALANCE>-1200.00</CLOSINGBALANCE></LEDGER>
      <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT><CLOSINGBALANCE>1200.00</CLOSINGBALANCE></LEDGER>
    `,
      { mode: "closing", conversionDate: "2026-12-31" },
    )

    const cash = result.accounts.find((account) => account.sourceName === "Cash")!
    const sales = result.accounts.find((account) => account.sourceName === "Sales")!
    assert.equal(cash.openingSide, "debit")
    assert.equal(cash.openingBalance, 1200)
    assert.equal(sales.openingSide, "credit")
    assert.equal(sales.openingBalance, 1200)
    assert.equal(result.opening.difference, 0)
    assert.ok(!result.exceptions.some((entry) => entry.code === "OPENING_DIFFERENCE"))
  })

  it("reads a stock value and its unit-suffixed rate from Tally's own sign", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>-5000.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>5000.00</OPENINGBALANCE></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <BASEUNITS>ea</BASEUNITS>
        <OPENINGBALANCE>2.00 ea</OPENINGBALANCE>
        <OPENINGRATE>2500.00/ea</OPENINGRATE>
        <OPENINGVALUE>-5000.00</OPENINGVALUE>
        <CLOSINGBALANCE>4.00 ea</CLOSINGBALANCE>
        <CLOSINGVALUE>-10000.00</CLOSINGVALUE>
      </STOCKITEM>
    `)

    const item = result.stockItems[0]
    assert.equal(item.quantity, 2)
    assert.equal(item.value, 5000)
    assert.equal(item.rate, 2500)
    assert.equal(item.closingValue, 10000)
    assert.equal(result.stock.openingValue, 5000)
    assert.equal(result.stock.closingValue, 10000)
    assert.equal(result.opening.difference, 0)
  })

  it("treats a ledger Tally leaves at nil as zero, not as an unexported balance", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSINGBALANCE></CLOSINGBALANCE></LEDGER>
      <LEDGER NAME="Untouched"><PARENT>Cash-in-hand</PARENT></LEDGER>
    `,
      { mode: "closing", conversionDate: "2026-12-31" },
    )

    const cash = result.accounts.find((account) => account.sourceName === "Cash")!
    assert.equal(cash.openingMethod, "closing")
    assert.equal(cash.openingBalance, 0)
    // The empty tag was answered; the missing one was not.
    const unavailable = result.exceptions.filter(
      (entry) => entry.code === "OPENING_BALANCE_UNAVAILABLE",
    )
    assert.deepEqual(unavailable.map((entry) => entry.detail), ["Untouched"])
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

  it("reports the exported opening and closing stock valuation without posting it", () => {
    const result = plan(`
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><OPENINGBALANCE>1800.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Inventory"><PARENT>Current Assets</PARENT><OPENINGBALANCE>1800.00</OPENINGBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>-3600.00</OPENINGBALANCE></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <OPENINGBALANCE>10 Strip</OPENINGBALANCE>
        <OPENINGRATE>100.00</OPENINGRATE>
        <OPENINGVALUE>1000.00</OPENINGVALUE>
        <CLOSEBALANCE>4 Strip</CLOSEBALANCE>
        <CLOSINGVALUE>400.00</CLOSINGVALUE>
      </STOCKITEM>
      <STOCKITEM NAME="Test Item B">
        <OPENINGBALANCE>8 Strip</OPENINGBALANCE>
        <OPENINGRATE>100.00</OPENINGRATE>
        <OPENINGVALUE>800.00</OPENINGVALUE>
        <CLOSEBALANCE>6 Strip</CLOSEBALANCE>
        <CLOSINGVALUE>600.00</CLOSINGVALUE>
      </STOCKITEM>
    `)

    assert.deepEqual(result.stock, {
      openingValue: 1800,
      closingValue: 1000,
      itemsWithOpeningValue: 2,
      itemsWithClosingValue: 2,
      itemCount: 2,
    })
    assert.equal(result.stockItems[0].closingValue, 400)
    assert.equal(result.stockItems[0].closingQuantity, 4)
    assert.ok(!result.exceptions.some((entry) => entry.code === "STOCK_CLOSING_VALUE_MISSING"))
  })

  it("leaves closing stock unavailable when the export carries no closing values", () => {
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

    assert.equal(result.stock.openingValue, 500)
    assert.equal(result.stock.closingValue, null)
    assert.equal(result.stock.itemsWithClosingValue, 0)
    assert.ok(result.exceptions.some((entry) => entry.code === "STOCK_CLOSING_VALUE_MISSING"))
  })

  it("takes the closing balances as the opening and posts no voucher in closing mode", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSEBALANCE>1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><CLOSEBALANCE>-1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
      <VOUCHER VCHTYPE="Journal" ACTION="Create">
        <GUID>journal-guid</GUID>
        <DATE>20260115</DATE>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>10.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Capital</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>-10.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    `,
      { mode: "closing", conversionDate: "2026-12-31" },
    )

    assert.equal(result.mode, "closing")
    assert.equal(result.conversionDate, "2026-12-31")
    assert.equal(result.vouchers.length, 0)
    assert.equal(result.counts.postedVouchers, 0)
    assert.equal(result.counts.skippedVouchers, 0)
    assert.equal(result.opening.difference, 0)

    const cash = result.accounts.find((account) => account.sourceName === "Cash")
    assert.equal(cash?.openingMethod, "closing")
    assert.equal(cash?.openingBalance, 1200)
    assert.equal(cash?.openingSide, "debit")
    assert.equal(result.opening.lines[0]?.description, "Tally closing balance")

    const codes = result.exceptions.map((entry) => entry.code)
    assert.ok(codes.includes("CLOSING_MODE_HISTORY_ONLY"))
    assert.ok(codes.includes("OPENING_BALANCE_UNAVAILABLE"))
    assert.ok(!codes.includes("CLOSING_PERIOD_MISMATCH"))
  })

  it("keeps a closing cut-over's sales as history without posting their vouchers", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSEBALANCE>1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><CLOSEBALANCE>-1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <BASEUNITS>Strip</BASEUNITS>
        <OPENINGBALANCE>12 Strip</OPENINGBALANCE>
        <CLOSEBALANCE>10 Strip</CLOSEBALANCE>
        <CLOSINGVALUE>900.00</CLOSINGVALUE>
        <BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-001</BATCHNAME>
          <EXPIRYDATE>20270228</EXPIRYDATE>
          <ACTUALQTY>10 Strip</ACTUALQTY>
          <AMOUNT>900.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
      </STOCKITEM>
      <VOUCHER VCHTYPE="Cash Sale" ACTION="Create">
        <GUID>sale-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>S-001</VOUCHERNUMBER>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>200.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>2 Strip</ACTUALQTY>
          <RATE>100.00/Strip</RATE>
          <AMOUNT>200.00</AMOUNT>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Sales</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>-200.00</AMOUNT>
            </LEDGERENTRIES.LIST>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
    `,
      { mode: "closing", conversionDate: "2026-12-31" },
    )

    // The ledger starts from the closing position, so the voucher is not posted…
    assert.equal(result.vouchers.length, 0)
    assert.equal(result.counts.postedVouchers, 0)
    // …but the sale it records is kept for the reports, and the stock position
    // stays the closing one.
    assert.equal(result.sales.length, 1)
    assert.equal(result.sales[0]?.total, 200)
    assert.equal(result.sales[0]?.paymentMethod, "CASH")
    assert.equal(result.counts.sales, 1)
    assert.equal(result.stockItems[0]?.quantity, 10)
    assert.equal(result.counts.skippedVouchers, 0)
  })

  it("blocks a closing cut-over when the export closes on another date", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSEBALANCE>1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><CLOSEBALANCE>-1200.00</CLOSEBALANCE></LEDGER>
    `,
      { mode: "closing", conversionDate: "2026-06-30" },
    )

    const mismatch = result.exceptions.find((entry) => entry.code === "CLOSING_PERIOD_MISMATCH")
    assert.equal(mismatch?.severity, "blocking")
    assert.match(mismatch?.message ?? "", /2026-12-31/)
  })

  it("defaults the closing cut-over date to the date the export closes on", () => {
    const result = plan(
      `
      <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT><CLOSEBALANCE>1200.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><CLOSEBALANCE>-1200.00</CLOSEBALANCE></LEDGER>
    `,
      { mode: "closing" },
    )

    assert.equal(result.conversionDate, "2026-12-31")
    assert.ok(!result.exceptions.some((entry) => entry.code === "CLOSING_PERIOD_MISMATCH"))
  })

  it("drops master batches that do not match the closing quantity", () => {
    const result = plan(
      `
      <LEDGER NAME="Inventory"><PARENT>Current Assets</PARENT><CLOSEBALANCE>400.00</CLOSEBALANCE></LEDGER>
      <LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><CLOSEBALANCE>-400.00</CLOSEBALANCE></LEDGER>
      <STOCKITEM NAME="Test Item A">
        <BASEUNITS>Strip</BASEUNITS>
        <OPENINGBALANCE>12 Strip</OPENINGBALANCE>
        <OPENINGRATE>1000.00</OPENINGRATE>
        <OPENINGVALUE>12000.00</OPENINGVALUE>
        <CLOSEBALANCE>4 Strip</CLOSEBALANCE>
        <CLOSINGVALUE>400.00</CLOSINGVALUE>
        <BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-001</BATCHNAME>
          <EXPIRYDATE>20270228</EXPIRYDATE>
          <ACTUALQTY>12 Strip</ACTUALQTY>
          <AMOUNT>12000.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
      </STOCKITEM>
    `,
      { mode: "closing", conversionDate: "2026-12-31" },
    )

    const item = result.stockItems[0]
    assert.equal(item.quantity, 4)
    assert.equal(item.value, 400)
    assert.equal(item.rate, 100)
    assert.equal(item.closingQuantity, 4)
    assert.equal(item.closingValue, 400)
    assert.equal(item.batches.length, 0)
    assert.equal(result.opening.difference, 0)

    // The P&L figures still report Tally's own opening as exported.
    assert.equal(result.stock.openingValue, 12000)
    assert.equal(result.stock.closingValue, 400)

    const codes = result.exceptions.map((entry) => entry.code)
    assert.ok(codes.includes("CLOSING_STOCK_BATCHES_UNAVAILABLE"))
    assert.ok(!codes.includes("OPENING_STOCK_QUANTITY_MISMATCH"))
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

  it("blocks a plan built from a source the parser stopped reading", () => {
    const document = parseTallyXmlRows(tallyExport(""))
    document.truncated = { reason: "RECORD_LIMIT", limit: 250_000, recordsProcessed: 250_000 }

    const result = normaliseTallyDocument(document, { conversionDate: "2026-01-01" })
    const truncated = result.exceptions.filter((entry) => entry.code === "SOURCE_TRUNCATED")

    assert.equal(truncated.length, 1)
    assert.equal(truncated[0].severity, "blocking")
    assert.match(truncated[0].message, /250,000 records/)
    assert.match(truncated[0].detail ?? "", /recordsProcessed=250000/)
    assert.match(truncated[0].detail ?? "", /reason=RECORD_LIMIT/)
  })

  it("blocks an export one record over the limit with the counts the parser saw", () => {
    const limit = TALLY_XML_ROW_LIMITS.MAX_RECORDS
    const records = '<GODOWN NAME="G"/>'.repeat(limit + 1)
    const document = parseTallyXmlRows(tallyExport(records))

    const result = normaliseTallyDocument(document, { conversionDate: "2026-01-01" })
    const truncated = result.exceptions.filter((entry) => entry.code === "SOURCE_TRUNCATED")

    assert.equal(truncated.length, 1)
    assert.equal(truncated[0].severity, "blocking")
    assert.equal(
      truncated[0].detail,
      `reason=RECORD_LIMIT; recordsProcessed=${limit}; limit=${limit}`,
    )
  })
})

describe("normaliseTallyDocument — replay", () => {
  const purchase = `
    <VOUCHER VCHTYPE="Purchase" ACTION="Create">
      <GUID>purchase-guid</GUID>
      <DATE>20260110</DATE>
      <VOUCHERNUMBER>P-010</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>Purchases</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>2000.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>Test Supplier A</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>-2000.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
        <ACTUALQTY>20 Strip</ACTUALQTY>
        <RATE>100.00/Strip</RATE>
        <AMOUNT>2000.00</AMOUNT>
        <BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-002</BATCHNAME>
          <EXPIRYDATE>20270331</EXPIRYDATE>
          <ACTUALQTY>20 Strip</ACTUALQTY>
          <AMOUNT>2000.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>
    </VOUCHER>
  `

  const sale = `
    <VOUCHER VCHTYPE="Sales" ACTION="Create">
      <GUID>sale-guid</GUID>
      <DATE>20260120</DATE>
      <VOUCHERNUMBER>S-010</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>Cash</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>300.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>Sales</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>-300.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
        <ACTUALQTY>3 Strip</ACTUALQTY>
        <RATE>100.00/Strip</RATE>
        <AMOUNT>300.00</AMOUNT>
      </ALLINVENTORYENTRIES.LIST>
    </VOUCHER>
  `

  it("captures purchases and sales as signed movements, in date order", () => {
    // The sale is exported first and dated later, so the sequence has to be
    // rebuilt rather than taken as the file's order.
    const result = plan(`${balancedMasters}${sale}${purchase}`, { mode: "replay" })

    assert.equal(result.mode, "replay")
    assert.equal(result.cutoffDate, "2026-12-31")
    assert.equal(result.ordering, "date-then-export-order")
    assert.deepEqual(
      result.vouchers.map((voucher) => voucher.date),
      ["2026-01-10", "2026-01-20"],
    )

    const movements = result.movements ?? []
    assert.equal(movements.length, 2)
    assert.deepEqual(
      movements.map((entry) => [
        entry.movementKind,
        entry.date,
        entry.quantityDelta,
        entry.batchNumber,
        entry.expiryDate,
        entry.allocation,
      ]),
      [
        ["purchase_in", "2026-01-10", 20, "B-002", "2027-03-31", "explicit"],
        ["sale_out", "2026-01-20", -3, undefined, undefined, "fefo"],
      ],
    )
    assert.equal(movements[0]?.amount, 2000)
    assert.equal(movements[0]?.rate, 100)
    assert.equal(movements[1]?.movementId, `${result.vouchers[1]?.sourceId}:L0:B0`)
  })

  it("takes a stock journal's direction from the list each line sits in", () => {
    const result = plan(
      `
      ${balancedMasters}
      <VOUCHER VCHTYPE="Stock Journal" ACTION="Create">
        <GUID>sj-guid</GUID>
        <DATE>20260115</DATE>
        <INVENTORYENTRIESOUT.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>5 Strip</ACTUALQTY>
          <AMOUNT>500.00</AMOUNT>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-001</BATCHNAME>
            <EXPIRYDATE>20270228</EXPIRYDATE>
            <ACTUALQTY>5 Strip</ACTUALQTY>
            <AMOUNT>500.00</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </INVENTORYENTRIESOUT.LIST>
        <INVENTORYENTRIESIN.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>5 Strip</ACTUALQTY>
          <AMOUNT>500.00</AMOUNT>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-003</BATCHNAME>
            <EXPIRYDATE>20280101</EXPIRYDATE>
            <ACTUALQTY>5 Strip</ACTUALQTY>
            <AMOUNT>500.00</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </INVENTORYENTRIESIN.LIST>
      </VOUCHER>
      `,
      { mode: "replay" },
    )

    assert.deepEqual(
      (result.movements ?? []).map((entry) => [
        entry.movementKind,
        entry.quantityDelta,
        entry.batchNumber,
      ]),
      [
        ["stock_journal_out", -5, "B-001"],
        ["stock_journal_in", 5, "B-003"],
      ],
    )
  })

  it("blocks a stock journal whose side the export does not state", () => {
    const result = plan(
      `
      ${balancedMasters}
      <VOUCHER VCHTYPE="Stock Journal" ACTION="Create">
        <GUID>sj-unknown</GUID>
        <DATE>20260115</DATE>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>5 Strip</ACTUALQTY>
          <AMOUNT>500.00</AMOUNT>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
      `,
      { mode: "replay" },
    )

    assert.equal(result.movements?.length, 0)
    assert.ok(
      result.exceptions.some(
        (entry) =>
          entry.code === "REPLAY_STOCK_JOURNAL_DIRECTION_UNKNOWN" &&
          entry.severity === "blocking",
      ),
    )
  })

  it("replays a physical stock voucher as the quantity that was counted", () => {
    const result = plan(
      `
      ${balancedMasters}
      <VOUCHER VCHTYPE="Physical Stock" ACTION="Create">
        <GUID>physical-guid</GUID>
        <DATE>20260125</DATE>
        <INVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>9 Strip</ACTUALQTY>
          <AMOUNT>900.00</AMOUNT>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-001</BATCHNAME>
            <EXPIRYDATE>20270228</EXPIRYDATE>
            <ACTUALQTY>9 Strip</ACTUALQTY>
            <AMOUNT>900.00</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </INVENTORYENTRIES.LIST>
      </VOUCHER>
      `,
      { mode: "replay" },
    )

    assert.deepEqual(
      (result.movements ?? []).map((entry) => [
        entry.movementKind,
        entry.quantityDelta,
        entry.batchNumber,
      ]),
      [["physical_adjust", 9, "B-001"]],
    )
  })

  it("splits a batch name that carries two expiries and discloses the reconstruction", () => {
    const secondPurchase = purchase
      .replace("purchase-guid", "purchase-guid-2")
      .replace("20260110", "20260112")
      .replace("20270331", "20270430")

    const result = plan(`${balancedMasters}${purchase}${secondPurchase}`, { mode: "replay" })

    const movements = result.movements ?? []
    assert.equal(movements.length, 2)
    // The earliest receipt keeps Tally's name; the later one cannot share the
    // row, so it gets a key of its own rather than a second expiry.
    assert.deepEqual(
      movements.map((entry) => [
        entry.batchNumber,
        entry.expiryDate,
        entry.allocation,
      ]),
      [
        ["B-002", "2027-03-31", "explicit"],
        [movements[1].batchNumber, "2027-04-30", "synthetic"],
      ],
    )
    assert.match(movements[1].batchNumber ?? "", /^TALLY-RPL-[0-9A-F]{16}$/)

    assert.ok(
      result.exceptions.some(
        (entry) =>
          entry.code === "REPLAY_BATCH_IDENTITY_RECONSTRUCTED" &&
          entry.severity === "warning",
      ),
    )
    assert.ok(!result.exceptions.some((entry) => entry.code === "BATCH_EXPIRY_CONFLICT"))
  })

  it("allocates a sale that names a colliding batch first-expiry-first-out", () => {
    const secondPurchase = purchase
      .replace("purchase-guid", "purchase-guid-2")
      .replace("20260110", "20260112")
      .replace("20270331", "20270430")
    const namedSale = sale.replace(
      "</ALLINVENTORYENTRIES.LIST>",
      `<BATCHALLOCATIONS.LIST>
          <BATCHNAME>B-002</BATCHNAME>
          <ACTUALQTY>3 Strip</ACTUALQTY>
          <AMOUNT>300.00</AMOUNT>
        </BATCHALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`,
    )

    const result = plan(`${balancedMasters}${purchase}${secondPurchase}${namedSale}`, {
      mode: "replay",
    })

    const outbound = (result.movements ?? []).find((entry) => entry.movementKind === "sale_out")
    assert.ok(outbound)
    assert.equal(outbound.batchNumber, undefined)
    assert.equal(outbound.allocation, "fefo")
    assert.ok(
      result.exceptions.some((entry) => entry.code === "REPLAY_BATCH_IDENTITY_RECONSTRUCTED"),
    )
  })

  it("blocks a voucher after the cutoff instead of replaying it", () => {
    const result = plan(
      `
      ${balancedMasters}
      <VOUCHER VCHTYPE="Purchase" ACTION="Create">
        <GUID>late-purchase</GUID>
        <DATE>20270115</DATE>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Purchases</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>2000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Test Supplier A</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>-2000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>20 Strip</ACTUALQTY>
          <AMOUNT>2000.00</AMOUNT>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-002</BATCHNAME>
            <EXPIRYDATE>20270331</EXPIRYDATE>
            <ACTUALQTY>20 Strip</ACTUALQTY>
            <AMOUNT>2000.00</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
      `,
      { mode: "replay" },
    )

    assert.equal(result.movements?.length, 0)
    assert.equal(result.vouchers.length, 0)
    assert.ok(
      result.exceptions.some(
        (entry) => entry.code === "REPLAY_VOUCHER_AFTER_CUTOFF" && entry.severity === "blocking",
      ),
    )
  })

  it("ignores a delivery note rather than counting its stock twice", () => {
    const result = plan(
      `
      ${balancedMasters}
      <VOUCHER VCHTYPE="Delivery Note" ACTION="Create">
        <GUID>delivery-guid</GUID>
        <DATE>20260118</DATE>
        <INVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>4 Strip</ACTUALQTY>
          <AMOUNT>400.00</AMOUNT>
        </INVENTORYENTRIES.LIST>
      </VOUCHER>
      `,
      { mode: "replay" },
    )

    assert.equal(result.movements?.length, 0)
    assert.ok(
      result.exceptions.some(
        (entry) => entry.code === "REPLAY_INVENTORY_NOTE_IGNORED" && entry.severity === "warning",
      ),
    )
  })

  it("returns stock on a credit note and keeps an already-expired batch as it was received", () => {
    const result = plan(
      `
      ${balancedMasters}
      <VOUCHER VCHTYPE="Credit Note" ACTION="Create">
        <GUID>credit-guid</GUID>
        <DATE>20260128</DATE>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Sales</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>100.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Test Customer A</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>-100.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ACTUALQTY>1 Strip</ACTUALQTY>
          <AMOUNT>100.00</AMOUNT>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-EXPIRED</BATCHNAME>
            <EXPIRYDATE>20260105</EXPIRYDATE>
            <ACTUALQTY>1 Strip</ACTUALQTY>
            <AMOUNT>100.00</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
      `,
      { mode: "replay" },
    )

    // The expiry is before the return date, which the replay reports when the
    // stock is next used; capture keeps what Tally actually recorded.
    assert.deepEqual(
      (result.movements ?? []).map((entry) => [
        entry.movementKind,
        entry.quantityDelta,
        entry.batchNumber,
        entry.expiryDate,
      ]),
      [["return_in", 1, "B-EXPIRED", "2026-01-05"]],
    )
  })

  it("replays stock carried by a payment voucher as an adjustment, not a purchase", () => {
    const payment = `
      <VOUCHER VCHTYPE="Payment" ACTION="Create">
        <GUID>payment-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>PMT-1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>40000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Test Supplier A</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-40000.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>Test Item A</STOCKITEMNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <ACTUALQTY>10 Strip</ACTUALQTY>
          <RATE>4000.00/Strip</RATE>
          <AMOUNT>40000.00</AMOUNT>
          <BATCHALLOCATIONS.LIST>
            <BATCHNAME>B-PAY</BATCHNAME>
            <EXPIRYDATE>20270401</EXPIRYDATE>
            <ACTUALQTY>10 Strip</ACTUALQTY>
            <AMOUNT>40000.00</AMOUNT>
          </BATCHALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>
    `
    const result = plan(`${balancedMasters}${payment}`, { mode: "replay" })

    assert.deepEqual(
      (result.movements ?? []).map((entry) => [entry.movementKind, entry.quantityDelta]),
      [["stock_journal_in", 10]],
    )
    assert.ok(
      result.exceptions.some(
        (entry) => entry.code === "REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER",
      ),
    )
  })

  it("discloses the Tally user and cost centre without withholding the voucher", () => {
    const attributed = `
      <VOUCHER VCHTYPE="Cash Sale">
        <GUID>attributed-guid</GUID>
        <DATE>20260115</DATE>
        <VOUCHERNUMBER>S-100</VOUCHERNUMBER>
        <ENTEREDBY>sam</ENTEREDBY>
        <ISCOSTCENTRE>Yes</ISCOSTCENTRE>
        <COSTCENTRENAME>Gloria</COSTCENTRENAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Cash</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>500.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Sales</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>-500.00</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    `
    const result = plan(`${balancedMasters}${attributed}`)

    assert.equal(result.counts.postedVouchers, 1)
    const enteredBy = result.exceptions.find((entry) => entry.code === "ENTERED_BY_NOT_MAPPED")
    assert.equal(enteredBy?.severity, "warning")
    assert.match(enteredBy?.message ?? "", /1 voucher.*\(sam\)/)
    const centre = result.exceptions.find((entry) => entry.code === "COST_CENTRE_NOT_MAPPED")
    assert.equal(centre?.severity, "warning")
    assert.match(centre?.message ?? "", /1 voucher.*\(Gloria\)/)
  })

  it("refuses a receipt with no expiry until the operator states the export has none", () => {
    const withoutExpiry = purchase.replace("<EXPIRYDATE>20270331</EXPIRYDATE>", "")
    const refused = plan(`${balancedMasters}${withoutExpiry}`, { mode: "replay" })

    assert.equal(refused.movements?.length, 0)
    assert.equal(
      refused.exceptions.find((entry) => entry.code === "REPLAY_MOVEMENT_EXPIRY_MISSING")?.severity,
      "blocking",
    )
    assert.equal(refused.batchExpiry, "source")

    const accepted = plan(`${balancedMasters}${withoutExpiry}`, {
      mode: "replay",
      batchExpiry: "not-supplied",
    })

    assert.equal(accepted.batchExpiry, "not-supplied")
    assert.deepEqual(
      (accepted.movements ?? []).map((entry) => [
        entry.movementKind,
        entry.quantityDelta,
        entry.batchNumber,
        entry.expiryDate,
        entry.allocation,
      ]),
      [["purchase_in", 20, "B-002", undefined, "explicit"]],
    )
    assert.ok(
      !accepted.exceptions.some(
        (entry) => entry.code === "REPLAY_MOVEMENT_EXPIRY_MISSING",
      ),
    )
    const aggregate = accepted.exceptions.filter(
      (entry) => entry.code === "REPLAY_BATCH_EXPIRY_NOT_SUPPLIED",
    )
    assert.equal(aggregate.length, 1)
    assert.equal(aggregate[0]?.severity, "warning")
    assert.match(aggregate[0]?.message ?? "", /^1 stock receipt across 1 product/)
  })

  it("says nothing about missing expiry when the export does state it", () => {
    const result = plan(`${balancedMasters}${purchase}`, {
      mode: "replay",
      batchExpiry: "not-supplied",
    })

    assert.equal(
      result.exceptions.filter((entry) => entry.code === "REPLAY_BATCH_EXPIRY_NOT_SUPPLIED").length,
      0,
    )
    assert.equal(result.movements?.[0]?.expiryDate, "2027-03-31")
  })

  it("blocks a cutoff that is not the period the export closes on", () => {
    const result = plan(`${balancedMasters}${purchase}`, {
      mode: "replay",
      cutoffDate: "2026-06-30",
    })

    assert.ok(
      result.exceptions.some(
        (entry) => entry.code === "REPLAY_PERIOD_MISMATCH" && entry.severity === "blocking",
      ),
    )
  })
})
