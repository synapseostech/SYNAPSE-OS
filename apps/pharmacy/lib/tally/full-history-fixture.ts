/**
 * A synthetic full-history export for the replay path.
 *
 * Every value is invented; no customer data is used. What it is for: a single
 * export that exercises the shapes the real archives carry — purchases, sales,
 * a return, a stock journal, a physical count — and, above all, a batch name
 * that Tally itself uses for more than one expiry ("Primary Batch"). The
 * importer must replay it without inventing an allocation and without losing
 * a movement.
 *
 * The same bytes are written to disk by scripts/tally-fixtures/generate.ts so
 * an operator can upload them in a walk-through.
 */

export const FULL_HISTORY_COMPANY = "ZZ Full History Pharmacy"
export const FULL_HISTORY_COMPANY_GUID = "2f000000-0000-4000-8000-000000000001"
export const FULL_HISTORY_PERIOD = { from: "2025-04-01", to: "2026-03-31" } as const
export const FULL_HISTORY_CURRENCY = "UGX"

export const FULL_HISTORY_ITEMS = {
  amoxicillin: "Amoxicillin 250mg",
  paracetamol: "Paracetamol 500mg",
} as const

/** The one batch name Tally uses twice, with two different expiries. */
export const COLLIDING_BATCH = {
  item: FULL_HISTORY_ITEMS.amoxicillin,
  name: "Primary Batch",
  primaryExpiry: "2026-06-30",
  laterExpiry: "2026-12-31",
} as const

const ACCOUNTS = [
  { name: "Cash-in-hand", parent: "Cash-in-Hand", opening: 0 },
  { name: "Sales Accounts", parent: "Sales Accounts", opening: 0 },
  { name: "Purchase Accounts", parent: "Purchase Accounts", opening: 0 },
  { name: "ZZ Customer", parent: "Sundry Debtors", opening: 0 },
  { name: "ZZ Supplier", parent: "Sundry Creditors", opening: 0 },
  { name: "Opening Balance Equity", parent: "Capital Account", opening: 0 },
]

const GROUPS = [
  { name: "Current Assets", parent: undefined },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Current Liabilities", parent: undefined },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Capital Account", parent: undefined },
  { name: "Sales Accounts", parent: undefined },
  { name: "Purchase Accounts", parent: undefined },
]

const STOCK_ITEMS = [
  { name: FULL_HISTORY_ITEMS.amoxicillin, unit: "Strip" },
  { name: FULL_HISTORY_ITEMS.paracetamol, unit: "Strip" },
]

type StockLine = {
  item: string
  quantity: number
  rate: number
  /** Tally's amount sign: positive into stock, negative out of it. */
  inbound: boolean
  batch?: string
  expiry?: string
  godown?: string
}

type Voucher = {
  guid: string
  type: string
  date: string
  number: string
  party?: string
  narration: string
  ledgers: Array<{ name: string; debit?: number; credit?: number }>
  stock?: StockLine[]
  /** Stock journals state their side by the list a line sits in. */
  journal?: { in: StockLine[]; out: StockLine[] }
  /** Physical-stock lines state a counted quantity, not a direction. */
  counted?: StockLine[]
}

const VOUCHERS: Voucher[] = [
  {
    guid: "2f000000-0000-4000-8000-000000000101",
    type: "Purchase",
    date: "2025-04-05",
    number: "PUR-0001",
    party: "ZZ Supplier",
    narration: "Synthetic purchase, first expiry under a shared batch name",
    ledgers: [
      { name: "Purchase Accounts", debit: 50_000 },
      { name: "ZZ Supplier", credit: 50_000 },
    ],
    stock: [
      {
        item: FULL_HISTORY_ITEMS.amoxicillin,
        quantity: 100,
        rate: 500,
        inbound: true,
        batch: COLLIDING_BATCH.name,
        expiry: COLLIDING_BATCH.primaryExpiry,
        godown: "Main Location",
      },
    ],
  },
  {
    guid: "2f000000-0000-4000-8000-000000000102",
    type: "Purchase",
    date: "2025-04-20",
    number: "PUR-0002",
    party: "ZZ Supplier",
    narration: "Synthetic purchase, same batch name with a later expiry",
    ledgers: [
      { name: "Purchase Accounts", debit: 31_200 },
      { name: "ZZ Supplier", credit: 31_200 },
    ],
    stock: [
      {
        item: FULL_HISTORY_ITEMS.amoxicillin,
        quantity: 60,
        rate: 520,
        inbound: true,
        batch: COLLIDING_BATCH.name,
        expiry: COLLIDING_BATCH.laterExpiry,
        godown: "Main Location",
      },
    ],
  },
  {
    guid: "2f000000-0000-4000-8000-000000000103",
    type: "Purchase",
    date: "2025-05-02",
    number: "PUR-0003",
    party: "ZZ Supplier",
    narration: "Synthetic purchase with a unique batch name",
    ledgers: [
      { name: "Purchase Accounts", debit: 60_000 },
      { name: "ZZ Supplier", credit: 60_000 },
    ],
    stock: [
      {
        item: FULL_HISTORY_ITEMS.paracetamol,
        quantity: 200,
        rate: 300,
        inbound: true,
        batch: "PARA-2401",
        expiry: "2027-03-31",
        godown: "Main Location",
      },
    ],
  },
  {
    guid: "2f000000-0000-4000-8000-000000000104",
    type: "Sales",
    date: "2025-06-10",
    number: "SAL-0001",
    narration: "Synthetic sale naming the shared batch name only",
    ledgers: [
      { name: "Cash-in-hand", debit: 24_000 },
      { name: "Sales Accounts", credit: 24_000 },
    ],
    stock: [
      {
        item: FULL_HISTORY_ITEMS.amoxicillin,
        quantity: 30,
        rate: 800,
        inbound: false,
        // No expiry: the name alone cannot say which expiry left the shelf.
        batch: COLLIDING_BATCH.name,
      },
    ],
  },
  {
    guid: "2f000000-0000-4000-8000-000000000105",
    type: "Sales",
    date: "2025-06-15",
    number: "SAL-0002",
    narration: "Synthetic sale naming a unique batch",
    ledgers: [
      { name: "Cash-in-hand", debit: 25_000 },
      { name: "Sales Accounts", credit: 25_000 },
    ],
    stock: [
      {
        item: FULL_HISTORY_ITEMS.paracetamol,
        quantity: 50,
        rate: 500,
        inbound: false,
        batch: "PARA-2401",
      },
    ],
  },
  {
    guid: "2f000000-0000-4000-8000-000000000106",
    type: "Credit Note",
    date: "2025-07-01",
    number: "CN-0001",
    narration: "Synthetic return restating the primary expiry",
    ledgers: [
      { name: "Sales Accounts", debit: 2_500 },
      { name: "Cash-in-hand", credit: 2_500 },
    ],
    stock: [
      {
        item: FULL_HISTORY_ITEMS.amoxicillin,
        quantity: 5,
        rate: 500,
        inbound: true,
        batch: COLLIDING_BATCH.name,
        expiry: COLLIDING_BATCH.primaryExpiry,
      },
    ],
  },
  {
    guid: "2f000000-0000-4000-8000-000000000107",
    type: "Stock Journal",
    date: "2025-08-01",
    number: "STK-0001",
    narration: "Synthetic repack between two batches",
    ledgers: [],
    journal: {
      out: [
        {
          item: FULL_HISTORY_ITEMS.amoxicillin,
          quantity: 10,
          rate: 500,
          inbound: false,
          batch: COLLIDING_BATCH.name,
          expiry: COLLIDING_BATCH.primaryExpiry,
        },
      ],
      in: [
        {
          item: FULL_HISTORY_ITEMS.amoxicillin,
          quantity: 10,
          rate: 500,
          inbound: true,
          batch: "AMOX-REPACK",
          expiry: COLLIDING_BATCH.primaryExpiry,
        },
      ],
    },
  },
  {
    guid: "2f000000-0000-4000-8000-000000000108",
    type: "Physical Stock",
    date: "2025-09-01",
    number: "PHY-0001",
    narration: "Synthetic physical count of a shared batch name",
    ledgers: [],
    counted: [
      {
        item: FULL_HISTORY_ITEMS.amoxicillin,
        quantity: 120,
        rate: 500,
        inbound: true,
        batch: COLLIDING_BATCH.name,
      },
    ],
  },
]

function money(value: number): string {
  return value.toFixed(2)
}

function tallyDate(iso: string): string {
  return iso.replace(/-/g, "")
}

function stockEntry(line: StockLine, element: string): string {
  const signed = line.inbound ? line.quantity * line.rate : -line.quantity * line.rate
  const amount = money(signed)
  return [
    `        <${element}>`,
    `          <STOCKITEMNAME>${line.item}</STOCKITEMNAME>`,
    `          <ISDEEMEDPOSITIVE>${line.inbound ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `          <RATE>${money(line.rate)}/Strip</RATE>`,
    `          <AMOUNT>${amount}</AMOUNT>`,
    `          <ACTUALQTY>${line.quantity} Strip</ACTUALQTY>`,
    ...(line.batch
      ? [
          "          <BATCHALLOCATIONS.LIST>",
          `            <BATCHNAME>${line.batch}</BATCHNAME>`,
          ...(line.expiry ? [`            <EXPIRYDATE>${tallyDate(line.expiry)}</EXPIRYDATE>`] : []),
          ...(line.godown ? [`            <GODOWNNAME>${line.godown}</GODOWNNAME>`] : []),
          `            <ACTUALQTY>${line.quantity} Strip</ACTUALQTY>`,
          `            <AMOUNT>${amount}</AMOUNT>`,
          "          </BATCHALLOCATIONS.LIST>",
        ]
      : []),
    `        </${element}>`,
  ].join("\n")
}

function voucherXml(voucher: Voucher): string {
  return [
    `      <VOUCHER VCHTYPE="${voucher.type}" GUID="${voucher.guid}">`,
    `        <DATE>${tallyDate(voucher.date)}</DATE>`,
    `        <GUID>${voucher.guid}</GUID>`,
    `        <VOUCHERNUMBER>${voucher.number}</VOUCHERNUMBER>`,
    voucher.party ? `        <PARTYLEDGERNAME>${voucher.party}</PARTYLEDGERNAME>` : "",
    `        <NARRATION>${voucher.narration}</NARRATION>`,
    `        <CURRENCYNAME>${FULL_HISTORY_CURRENCY}</CURRENCYNAME>`,
    ...voucher.ledgers.map((ledger) => {
      const debit = ledger.debit ?? 0
      return [
        "        <ALLLEDGERENTRIES.LIST>",
        `          <LEDGERNAME>${ledger.name}</LEDGERNAME>`,
        `          <ISDEEMEDPOSITIVE>${debit > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
        `          <AMOUNT>${debit > 0 ? money(debit) : money(-(ledger.credit ?? 0))}</AMOUNT>`,
        "        </ALLLEDGERENTRIES.LIST>",
      ].join("\n")
    }),
    ...(voucher.stock ?? []).map((line) => stockEntry(line, "ALLINVENTORYENTRIES.LIST")),
    ...(voucher.journal?.out ?? []).map((line) => stockEntry(line, "INVENTORYENTRIESOUT.LIST")),
    ...(voucher.journal?.in ?? []).map((line) => stockEntry(line, "INVENTORYENTRIESIN.LIST")),
    ...(voucher.counted ?? []).map((line) => stockEntry(line, "INVENTORYENTRIES.LIST")),
    "      </VOUCHER>",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildFullHistoryXml(): string {
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
    `        <COMPANYNAME>${FULL_HISTORY_COMPANY}</COMPANYNAME>`,
    `        <GUID>${FULL_HISTORY_COMPANY_GUID}</GUID>`,
    `        <SVFROMDATE>${tallyDate(FULL_HISTORY_PERIOD.from)}</SVFROMDATE>`,
    `        <SVTODATE>${tallyDate(FULL_HISTORY_PERIOD.to)}</SVTODATE>`,
    `        <CURRENCYNAME>${FULL_HISTORY_CURRENCY}</CURRENCYNAME>`,
    "      </COMPANY>",
    ...GROUPS.map((group) =>
      group.parent
        ? [`      <GROUP NAME="${group.name}"><PARENT>${group.parent}</PARENT></GROUP>`].join("\n")
        : [`      <GROUP NAME="${group.name}" />`].join("\n"),
    ),
    ...ACCOUNTS.map((account) =>
      [
        `      <LEDGER NAME="${account.name}">`,
        `        <PARENT>${account.parent}</PARENT>`,
        `        <OPENINGBALANCE>${money(account.opening)}</OPENINGBALANCE>`,
        "      </LEDGER>",
      ].join("\n"),
    ),
    '      <UNIT NAME="Strip">',
    "        <SYMBOL>strip</SYMBOL>",
    "      </UNIT>",
    '      <GODOWN NAME="Main Location"/>',
    ...STOCK_ITEMS.map((item) =>
      [
        `      <STOCKITEM NAME="${item.name}">`,
        '        <PARENT>Primary</PARENT>',
        `        <BASEUNITS>${item.unit}</BASEUNITS>`,
        "        <ISBATCHWISEON>Yes</ISBATCHWISEON>",
        "        <ISEXPIRYON>Yes</ISEXPIRYON>",
        "      </STOCKITEM>",
      ].join("\n"),
    ),
    ...VOUCHERS.map(voucherXml),
    "        </TALLYMESSAGE>",
    "      </REQUESTDATA>",
    "    </IMPORTDATA>",
    "  </BODY>",
    "</ENVELOPE>",
  ].join("\n")
}

export type FullHistoryExpectation = {
  date: string
  kind: string
  item: string
  quantity: number
  batch?: string
  syntheticBatch?: boolean
  expiry?: string
  allocation: "explicit" | "fefo" | "synthetic"
}

/** What a correct replay must produce, in order. */
export const FULL_HISTORY_EXPECTATIONS: FullHistoryExpectation[] = [
  {
    date: "2025-04-05",
    kind: "purchase_in",
    item: COLLIDING_BATCH.item,
    quantity: 100,
    batch: COLLIDING_BATCH.name,
    expiry: COLLIDING_BATCH.primaryExpiry,
    allocation: "explicit",
  },
  {
    date: "2025-04-20",
    kind: "purchase_in",
    item: COLLIDING_BATCH.item,
    quantity: 60,
    syntheticBatch: true,
    expiry: COLLIDING_BATCH.laterExpiry,
    allocation: "synthetic",
  },
  {
    date: "2025-05-02",
    kind: "purchase_in",
    item: FULL_HISTORY_ITEMS.paracetamol,
    quantity: 200,
    batch: "PARA-2401",
    expiry: "2027-03-31",
    allocation: "explicit",
  },
  {
    date: "2025-06-10",
    kind: "sale_out",
    item: COLLIDING_BATCH.item,
    quantity: -30,
    allocation: "fefo",
  },
  {
    date: "2025-06-15",
    kind: "sale_out",
    item: FULL_HISTORY_ITEMS.paracetamol,
    quantity: -50,
    batch: "PARA-2401",
    allocation: "explicit",
  },
  {
    date: "2025-07-01",
    kind: "return_in",
    item: COLLIDING_BATCH.item,
    quantity: 5,
    batch: COLLIDING_BATCH.name,
    expiry: COLLIDING_BATCH.primaryExpiry,
    allocation: "explicit",
  },
  {
    date: "2025-08-01",
    kind: "stock_journal_out",
    item: COLLIDING_BATCH.item,
    quantity: -10,
    batch: COLLIDING_BATCH.name,
    expiry: COLLIDING_BATCH.primaryExpiry,
    allocation: "explicit",
  },
  {
    date: "2025-08-01",
    kind: "stock_journal_in",
    item: COLLIDING_BATCH.item,
    quantity: 10,
    batch: "AMOX-REPACK",
    expiry: COLLIDING_BATCH.primaryExpiry,
    allocation: "explicit",
  },
  {
    date: "2025-09-01",
    kind: "physical_adjust",
    item: COLLIDING_BATCH.item,
    quantity: 120,
    syntheticBatch: true,
    allocation: "synthetic",
  },
]
