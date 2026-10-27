/**
 * Anonymised Tally cut-over fixtures.
 *
 * One synthetic company with no real party, product or clinical data, emitted as
 * the three formats the importer accepts. Tests round-trip all three through the
 * real parsers, and `scripts/tally-fixtures/generate.ts` writes them to disk for
 * a manual walk-through of upload → preview → apply.
 */

import * as XLSX from "xlsx"
import Papa from "papaparse"
import type { TallyTabularRecords } from "./workbook"

export const FIXTURE_COMPANY = "Test Pharmacy Ltd"
export const FIXTURE_COMPANY_GUID = "1f000000-0000-4000-8000-000000000001"
export const FIXTURE_PERIOD = { from: "2025-04-01", to: "2026-03-31" } as const
export const FIXTURE_CURRENCY = "UGX"

type FixtureAccount = {
  name: string
  parent: string
  opening: number
  bill?: number
}

/** Opening balances at the cut-over date; debit positive, credit negative. */
const ACCOUNTS: FixtureAccount[] = [
  { name: "Cash-in-hand", parent: "Cash-in-Hand", opening: 100_000 },
  { name: "Bank Account", parent: "Bank Accounts", opening: 500_000 },
  { name: "Test Party A", parent: "Sundry Debtors", opening: 0, bill: 100_000 },
  { name: "Test Party B", parent: "Sundry Creditors", opening: 0, bill: 36_000 },
  { name: "Sales Accounts", parent: "Sales Accounts", opening: 0 },
  { name: "Purchase Accounts", parent: "Purchase Accounts", opening: 0 },
  { name: "Stock-in-hand", parent: "Stock-in-Hand", opening: 0 },
  { name: "Opening Balance Equity", parent: "Capital Account", opening: -600_000 },
]

type FixtureStockLine = {
  item: string
  quantity: number
  unit: string
  rate: number
  amount: number
  batch: string
  expiry: string
  godown: string
}

type FixtureVoucher = {
  id: string
  guid: string
  type: string
  date: string
  number: string
  party?: string
  narration: string
  lines: Array<{ ledger: string; debit?: number; credit?: number }>
  stock?: FixtureStockLine[]
}

const VOUCHERS: FixtureVoucher[] = [
  {
    id: "v-journal-1",
    guid: "1f000000-0000-4000-8000-000000000101",
    type: "Journal",
    date: "2025-04-01",
    number: "JRN-0001",
    narration: "Opening stock brought forward",
    lines: [
      { ledger: "Stock-in-hand", debit: 280_000 },
      { ledger: "Opening Balance Equity", credit: 280_000 },
    ],
  },
  {
    id: "v-sale-1",
    guid: "1f000000-0000-4000-8000-000000000102",
    type: "Sales",
    date: "2025-05-10",
    number: "SAL-0001",
    party: "Test Party A",
    narration: "Test sale of Test Item A",
    lines: [
      { ledger: "Test Party A", debit: 100_000 },
      { ledger: "Sales Accounts", credit: 100_000 },
    ],
    stock: [
      {
        item: "Test Item A",
        quantity: 40,
        unit: "Strip",
        rate: 500,
        amount: 20_000,
        batch: "Test Batch A",
        expiry: "2027-06-30",
        godown: "Main Location",
      },
    ],
  },
  {
    id: "v-purchase-1",
    guid: "1f000000-0000-4000-8000-000000000103",
    type: "Purchase",
    date: "2025-05-12",
    number: "PUR-0001",
    party: "Test Party B",
    narration: "Test purchase of Test Item A",
    lines: [
      { ledger: "Purchase Accounts", debit: 36_000 },
      { ledger: "Test Party B", credit: 36_000 },
    ],
    stock: [
      {
        item: "Test Item A",
        quantity: 60,
        unit: "Strip",
        rate: 600,
        amount: 36_000,
        batch: "Test Batch B",
        expiry: "2028-01-31",
        godown: "Main Location",
      },
    ],
  },
  {
    id: "v-receipt-1",
    guid: "1f000000-0000-4000-8000-000000000104",
    type: "Receipt",
    date: "2025-05-20",
    number: "RCT-0001",
    party: "Test Party A",
    narration: "Test receipt from Test Party A",
    lines: [
      { ledger: "Cash-in-hand", debit: 40_000 },
      { ledger: "Test Party A", credit: 40_000 },
    ],
  },
  {
    id: "v-payment-1",
    guid: "1f000000-0000-4000-8000-000000000105",
    type: "Payment",
    date: "2025-05-25",
    number: "PAY-0001",
    party: "Test Party B",
    narration: "Test payment to Test Party B",
    lines: [
      { ledger: "Test Party B", debit: 20_000 },
      { ledger: "Bank Account", credit: 20_000 },
    ],
  },
  {
    id: "v-contra-1",
    guid: "1f000000-0000-4000-8000-000000000106",
    type: "Contra",
    date: "2025-05-28",
    number: "CNT-0001",
    narration: "Test cash deposit to bank",
    lines: [
      { ledger: "Bank Account", debit: 50_000 },
      { ledger: "Cash-in-hand", credit: 50_000 },
    ],
  },
]

const STOCK_ITEMS = [
  {
    name: "Test Item A",
    parent: "Test Formulations",
    unit: "Strip",
    opening_quantity: 100,
    opening_rate: 2_800,
    opening_value: 280_000,
  },
  {
    name: "Test Item B",
    parent: "Test Formulations",
    unit: "Bottle",
    opening_quantity: 0,
    opening_rate: 0,
    opening_value: 0,
  },
]

const STOCK_BATCHES = [
  {
    stock_item: "Test Item A",
    batch: "Test Batch A",
    expiry: "2027-06-30",
    quantity: 100,
    amount: 280_000,
    godown: "Main Location",
  },
]

const BILLS = [
  { ledger: "Test Party A", name: "SAL-0001", amount: 100_000, bill_type: "New Ref", credit_days: 30 },
  { ledger: "Test Party B", name: "PUR-0001", amount: 36_000, bill_type: "New Ref", credit_days: 30 },
]

export function buildFixtureRecords(): TallyTabularRecords {
  return {
    meta: [
      { key: "company", value: FIXTURE_COMPANY },
      { key: "company_guid", value: FIXTURE_COMPANY_GUID },
      { key: "currency", value: FIXTURE_CURRENCY },
      { key: "period_from", value: FIXTURE_PERIOD.from },
      { key: "period_to", value: FIXTURE_PERIOD.to },
    ],
    accounts: ACCOUNTS.map((account) => ({
      name: account.name,
      parent: account.parent,
      opening_balance: account.opening,
    })),
    stockItems: STOCK_ITEMS,
    stockBatches: STOCK_BATCHES,
    vouchers: VOUCHERS.map((voucher) => ({
      id: voucher.id,
      guid: voucher.guid,
      type: voucher.type,
      date: voucher.date,
      number: voucher.number,
      party: voucher.party ?? "",
      narration: voucher.narration,
      currency: FIXTURE_CURRENCY,
    })),
    voucherLines: VOUCHERS.flatMap((voucher) =>
      voucher.lines.map((line) => ({
        voucher_id: voucher.id,
        ledger: line.ledger,
        debit: line.debit ?? "",
        credit: line.credit ?? "",
      })),
    ),
    stockLines: VOUCHERS.flatMap((voucher) =>
      (voucher.stock ?? []).map((line) => ({
        voucher_id: voucher.id,
        stock_item: line.item,
        quantity: line.quantity,
        unit: line.unit,
        rate: line.rate,
        amount: line.amount,
        godown: line.godown,
        batch: line.batch,
        expiry: line.expiry,
      })),
    ),
    bills: BILLS,
  }
}

export function buildFixtureWorkbook(): Uint8Array {
  const records = buildFixtureRecords()
  const workbook = XLSX.utils.book_new()
  const add = (sheet: string, rows: TallyTabularRecords[keyof TallyTabularRecords]) => {
    const header = Object.keys(rows[0] ?? {})
    const matrix = [header, ...rows.map((row) => header.map((key) => row[key] ?? ""))]
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheet)
  }
  add("Meta", records.meta)
  add("Accounts", records.accounts)
  add("StockItems", records.stockItems)
  add("StockBatches", records.stockBatches)
  add("Vouchers", records.vouchers)
  add("VoucherLines", records.voucherLines)
  add("StockLines", records.stockLines)
  add("BillAllocations", records.bills)
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

export function buildFixtureCsv(): string {
  const records = buildFixtureRecords()
  const tagged = <T extends Record<string, unknown>>(recordType: string, rows: T[]) =>
    rows.map((row) => ({ record_type: recordType, ...row }))

  const rows = [
    ...tagged("meta", records.meta),
    ...tagged("account", records.accounts),
    ...tagged("stock_item", records.stockItems),
    ...tagged("stock_batch", records.stockBatches),
    ...tagged("voucher", records.vouchers),
    ...tagged("voucher_line", records.voucherLines),
    ...tagged("stock_line", records.stockLines),
    ...tagged("bill", records.bills),
  ]

  // Rows differ per record type; Papa would take the header from the first row
  // alone and drop every other column, so the union is spelled out.
  const columns: string[] = ["record_type"]
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key)
    }
  }

  return Papa.unparse(rows, { columns })
}

function amount(value: number): string {
  return value.toFixed(2)
}

function xmlLedgerEntry(
  line: { ledger: string; debit?: number; credit?: number },
  party: string | undefined,
): string {
  const debit = line.debit ?? 0
  const partyFlag =
    party && line.ledger.toLowerCase() === party.toLowerCase()
      ? "\n          <ISPARTYLEDGER>Yes</ISPARTYLEDGER>"
      : ""
  return [
    "        <LEDGERENTRIES.LIST>",
    `          <LEDGERNAME>${line.ledger}</LEDGERNAME>${partyFlag}`,
    `          <ISDEEMEDPOSITIVE>${debit > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `          <AMOUNT>${debit > 0 ? amount(debit) : amount(-(line.credit ?? 0))}</AMOUNT>`,
    "        </LEDGERENTRIES.LIST>",
  ].join("\n")
}

function xmlStockEntry(line: FixtureStockLine): string {
  return [
    "        <ALLINVENTORYENTRIES.LIST>",
    `          <STOCKITEMNAME>${line.item}</STOCKITEMNAME>`,
    "          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
    `          <RATE>${amount(line.rate)}/${line.unit}</RATE>`,
    `          <AMOUNT>${amount(-line.amount)}</AMOUNT>`,
    `          <ACTUALQTY>${line.quantity} ${line.unit}</ACTUALQTY>`,
    `          <BILLEDQTY>${line.quantity} ${line.unit}</BILLEDQTY>`,
    "          <BATCHALLOCATIONS.LIST>",
    `            <BATCHNAME>${line.batch}</BATCHNAME>`,
    `            <EXPIRYDATE>${line.expiry.replace(/-/g, "")}</EXPIRYDATE>`,
    `            <GODOWNNAME>${line.godown}</GODOWNNAME>`,
    `            <ACTUALQTY>${line.quantity} ${line.unit}</ACTUALQTY>`,
    `            <AMOUNT>${amount(-line.amount)}</AMOUNT>`,
    "          </BATCHALLOCATIONS.LIST>",
    "        </ALLINVENTORYENTRIES.LIST>",
  ].join("\n")
}

function xmlVoucher(voucher: FixtureVoucher): string {
  return [
    '      <VOUCHER VCHTYPE="' + voucher.type + '" GUID="' + voucher.guid + '">',
    `        <DATE>${voucher.date.replace(/-/g, "")}</DATE>`,
    `        <GUID>${voucher.guid}</GUID>`,
    `        <VOUCHERNUMBER>${voucher.number}</VOUCHERNUMBER>`,
    voucher.party ? `        <PARTYLEDGERNAME>${voucher.party}</PARTYLEDGERNAME>` : "",
    `        <NARRATION>${voucher.narration}</NARRATION>`,
    `        <CURRENCYNAME>${FIXTURE_CURRENCY}</CURRENCYNAME>`,
    ...voucher.lines.map((line) => xmlLedgerEntry(line, voucher.party)),
    ...(voucher.stock ?? []).map((line) => xmlStockEntry(line)),
    "      </VOUCHER>",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildFixtureXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ENVELOPE>",
    "  <HEADER>",
    "    <TALLYREQUEST>Import Data</TALLYREQUEST>",
    "  </HEADER>",
    "  <BODY>",
    "    <IMPORTDATA>",
    "      <REQUESTDESC>",
    "        <REPORTNAME>All Masters</REPORTNAME>",
    "      </REQUESTDESC>",
    "      <REQUESTDATA>",
    '        <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    "      <COMPANY>",
    `        <COMPANYNAME>${FIXTURE_COMPANY}</COMPANYNAME>`,
    `        <GUID>${FIXTURE_COMPANY_GUID}</GUID>`,
    `        <SVFROMDATE>${FIXTURE_PERIOD.from.replace(/-/g, "")}</SVFROMDATE>`,
    `        <SVTODATE>${FIXTURE_PERIOD.to.replace(/-/g, "")}</SVTODATE>`,
    `        <CURRENCYNAME>${FIXTURE_CURRENCY}</CURRENCYNAME>`,
    "      </COMPANY>",
    ...ACCOUNTS.map((account) =>
      [
        `      <LEDGER NAME="${account.name}">`,
        `        <PARENT>${account.parent}</PARENT>`,
        account.bill ? "        <ISBILLWISEON>Yes</ISBILLWISEON>" : "",
        `        <OPENINGBALANCE>${amount(account.opening)}</OPENINGBALANCE>`,
        "      </LEDGER>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    '      <UNIT NAME="Strip">',
    "        <SYMBOL>strip</SYMBOL>",
    "      </UNIT>",
    '      <UNIT NAME="Bottle">',
    "        <SYMBOL>bottle</SYMBOL>",
    "      </UNIT>",
    '      <GODOWN NAME="Main Location"/>',
    '      <STOCKGROUP NAME="Test Formulations">',
    "        <PARENT>Primary</PARENT>",
    "      </STOCKGROUP>",
    ...STOCK_ITEMS.map((item) =>
      [
        `      <STOCKITEM NAME="${item.name}">`,
        `        <PARENT>${item.parent}</PARENT>`,
        `        <BASEUNITS>${item.unit}</BASEUNITS>`,
        "        <ISBATCHWISEON>Yes</ISBATCHWISEON>",
        `        <OPENINGBALANCE>${item.opening_quantity} ${item.unit}</OPENINGBALANCE>`,
        `        <OPENINGRATE>${amount(item.opening_rate)}</OPENINGRATE>`,
        `        <OPENINGVALUE>${amount(item.opening_value)}</OPENINGVALUE>`,
        "      </STOCKITEM>",
      ].join("\n"),
    ),
    ...VOUCHERS.map(xmlVoucher),
    "        </TALLYMESSAGE>",
    "      </REQUESTDATA>",
    "    </IMPORTDATA>",
    "  </BODY>",
    "</ENVELOPE>",
  ]
    .filter(Boolean)
    .join("\n")
}
