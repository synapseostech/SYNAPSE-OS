import { beforeEach, describe, expect, it, vi } from "vitest"

// The reports route aggregates in JS, so the queries are simulated here. The
// accounting point under test is the basis each row is summed on, not the SQL.
const m = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  data: {} as Record<string, unknown[]>,
  errors: {} as Record<string, { message: string } | undefined>,
  ledgerSales: [] as unknown[],
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "u-1" } },
    tenantId: "tenant-1",
  })),
}))

vi.mock("@/lib/pos/sale-ledger", () => ({
  listLedgerSalesForHistory: vi.fn(async () => m.ledgerSales),
}))

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      for (const op of ["select", "eq", "gte", "lte", "order", "in"]) {
        builder[op] = (...args: unknown[]) => {
          m.calls.push({ table, op, args })
          return builder
        }
      }
      ;(builder as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: m.data[table] ?? [],
          error: m.errors[table] ?? null,
          count: (m.data[table] ?? []).length,
        }).then(resolve)
      return builder
    },
  },
}))

const getReport = async (query: string) => {
  const { GET } = await import("./route")
  const res = await GET({
    url: `http://localhost/api/admin/reports?${query}`,
  } as never)
  return { status: res.status, body: await res.json() }
}

const getSalesReport = (query = "type=sales&period=today") => getReport(query)

const saleRow = {
  id: "sale-1",
  receipt_number: "R-1",
  total_amount: 1180,
  discount_total: 0,
  tax_amount: 180,
  payment_method: "CASH",
  cashier_id: "u-1",
  created_at: "2026-11-01T10:00:00.000Z",
}

const saleItemRow = {
  product_id: "p-1",
  quantity: 2,
  unit_price: 500,
  discount_amount: 50,
  line_total: 950,
  pharmacy_products: { name: "Amoxicillin", sku: "AMX", category: "Antibiotics" },
}

const callsFor = (table: string, op: string) =>
  m.calls.filter((c) => c.table === table && c.op === op)

beforeEach(() => {
  m.calls = []
  m.errors = {}
  m.ledgerSales = []
  m.data = {
    pharmacy_transactions: [],
    pharmacy_transaction_items: [],
    pharmacy_pos_sales: [saleRow],
    pharmacy_pos_sale_items: [saleItemRow],
  }
})

describe("GET /api/admin/reports?type=sales", () => {
  it("reports a POS sale on a tax-exclusive basis so VAT is not counted twice", async () => {
    const r = await getSalesReport()
    expect(r.status).toBe(200)
    // total_amount (1180) already contains tax; net sales must be 1000 and the
    // tax card 180, not 1180 + 180.
    expect(r.body.summary.totalSales).toBe(1000)
    expect(r.body.summary.totalTax).toBe(180)
    expect(r.body.transactions[0].net_amount).toBe(1000)
  })

  it("reports a Tally-mirrored row on the same tax-exclusive basis", async () => {
    // What the cut-over writes: voucher goods 450, output VAT 50, cash 500.
    // `apply.ts` stores the pre-tax total in net_amount and the VAT separately.
    m.data.pharmacy_pos_sales = []
    m.data.pharmacy_pos_sale_items = []
    m.data.pharmacy_transactions = [
      {
        id: "tx-tally",
        transaction_no: "TALLY-S-001",
        total_amount: 450,
        discount: 0,
        tax: 50,
        net_amount: 450,
        payment_method: "CASH",
        cashier_id: "u-1",
        created_at: "2026-11-01T09:00:00.000Z",
      },
    ]

    const r = await getSalesReport()
    expect(r.body.summary.totalSales).toBe(450)
    expect(r.body.summary.totalTax).toBe(50)
    expect(r.body.transactions[0].net_amount).toBe(450)
  })

  it("does not charge VAT twice on a row the edit route rewrote", async () => {
    // The edit route stores net_amount = total - discount + tax (inclusive),
    // unlike every other writer. The report must not take that as revenue on
    // top of the tax card.
    m.data.pharmacy_pos_sales = []
    m.data.pharmacy_pos_sale_items = []
    m.data.pharmacy_transactions = [
      {
        id: "tx-edited",
        transaction_no: "TX-9",
        total_amount: 2000,
        discount: 100,
        tax: 342,
        net_amount: 2242,
        payment_method: "CASH",
        cashier_id: "u-1",
        created_at: "2026-11-01T09:00:00.000Z",
      },
    ]

    const r = await getSalesReport()
    expect(r.body.summary.totalSales).toBe(1900)
    expect(r.body.summary.totalTax).toBe(342)
    expect(r.body.summary.totalDiscount).toBe(100)
    expect(r.body.transactions[0].net_amount).toBe(1900)
  })

  it("counts POS line discounts, which never reach discount_total", async () => {
    const r = await getSalesReport()
    expect(r.body.summary.totalDiscount).toBe(50)
  })

  it("attributes a POS sale to its cashier instead of Unknown Staff", async () => {
    // POS rows carry only `cashier_id`; the report has to resolve the profile.
    m.data.profiles = [
      { id: "u-1", full_name: "Pilot Cashier", first_name: "Pilot", last_name: "Cashier" },
    ]

    const r = await getSalesReport()
    expect(r.body.salesByUser[0].user.name).toBe("Pilot Cashier")
    expect(callsFor("profiles", "in").map((c) => c.args)).toContainEqual(["id", ["u-1"]])
  })

  it("falls back to Unknown Staff when the cashier profile is missing", async () => {
    const r = await getSalesReport()
    expect(r.body.salesByUser[0].user.name).toBe("Unknown Staff")
  })

  it("scopes every query to the caller's tenant", async () => {
    await getSalesReport()
    for (const table of [
      "pharmacy_transactions",
      "pharmacy_transaction_items",
      "pharmacy_pos_sales",
      "pharmacy_pos_sale_items",
    ]) {
      const eqs = callsFor(table, "eq").map((c) => c.args)
      expect(eqs).toContainEqual(["tenant_id", "tenant-1"])
    }
  })

  it("excludes voided POS sales rather than counting them as revenue", async () => {
    await getSalesReport()
    const statusFilters = callsFor("pharmacy_pos_sales", "eq").map((c) => c.args)
    expect(statusFilters).toContainEqual(["status", "completed"])
    const itemStatusFilters = callsFor("pharmacy_pos_sale_items", "eq").map((c) => c.args)
    expect(itemStatusFilters).toContainEqual(["pharmacy_pos_sales.status", "completed"])
  })

  it("builds the tax breakdown from the tax frozen on each sale line", async () => {
    m.data.pharmacy_pos_sale_items = [
      {
        ...saleItemRow,
        discount_amount: 0,
        line_total: 1000,
        vat_category: "standard",
        taxable_amount: 1000,
        tax_amount: 180,
        tax_source: "vat",
      },
      {
        ...saleItemRow,
        product_id: "p-2",
        discount_amount: 0,
        line_total: 500,
        vat_category: "exempt",
        taxable_amount: 0,
        tax_amount: 0,
        tax_source: "vat",
      },
    ]

    const r = await getSalesReport()
    expect(r.body.tax).toMatchObject({
      source: "vat",
      standardTaxable: 1000,
      standardTax: 180,
      exemptSales: 500,
      zeroRatedSales: 0,
      lineTaxTotal: 180,
      linesRecorded: 2,
      linesMissingTaxData: 0,
    })
    expect(r.body.taxReconciliation).toEqual({ headerTax: 180, lineTax: 180, difference: 0 })
  })

  it("reports lines that predate line-level tax instead of assuming they were untaxed", async () => {
    // The default saleItemRow carries no tax snapshot — a sale from before 20261102110000.
    const r = await getSalesReport()
    expect(r.body.tax.linesRecorded).toBe(0)
    expect(r.body.tax.linesMissingTaxData).toBe(1)
    expect(r.body.taxReconciliation).toEqual({ headerTax: 180, lineTax: 0, difference: 180 })
  })

  it("keeps reporting revenue when the line-tax query fails on an unmigrated database", async () => {
    m.errors.pharmacy_pos_sale_items = { message: "column tax_source does not exist" }

    const r = await getSalesReport()
    expect(r.status).toBe(200)
    expect(r.body.summary.totalSales).toBe(1000)
    expect(r.body.summary.totalTax).toBe(180)
    expect(r.body.tax.linesRecorded).toBe(0)
  })
})

describe("GET /api/admin/reports?type=profit", () => {
  it("groups profit by the product's category instead of one Uncategorized bucket", async () => {
    m.ledgerSales = [
      {
        id: "sale-1",
        status: "COMPLETED",
        items: [
          {
            id: "li-1",
            quantity: 2,
            unitPrice: 500,
            costPrice: 300,
            totalPrice: 1000,
            product: { id: "p-1", name: "Amoxicillin", sku: "AMX", category: "Antibiotics" },
            batch: null,
          },
          {
            id: "li-2",
            quantity: 1,
            unitPrice: 200,
            costPrice: 100,
            totalPrice: 200,
            product: { id: "p-2", name: "Paracetamol", sku: "PCM", category: "Analgesics" },
            batch: null,
          },
        ],
      },
    ]

    const r = await getReport("type=profit&period=today")
    expect(r.status).toBe(200)
    const categories = (r.body.profitByCategory as Array<{ category: string }>).map(
      (c) => c.category,
    )
    expect(categories.sort()).toEqual(["Analgesics", "Antibiotics"])
    expect(r.body.summary.totalRevenue).toBe(1200)
    expect(r.body.summary.totalCost).toBe(700)
  })

  it("costs a mirrored Tally sale at the batch rate it moved at, not today's product cost", async () => {
    m.ledgerSales = [
      {
        id: "tx-1",
        status: "COMPLETED",
        items: [
          {
            id: "li-1",
            quantity: 5,
            unitPrice: 400,
            costPrice: 120,
            totalPrice: 2000,
            product: { id: "p-1", name: "Amoxicillin", sku: "AMX", category: "Antibiotics", cost_price: 380 },
            batch: null,
          },
        ],
      },
    ]

    const r = await getReport("type=profit&period=today")
    expect(r.status).toBe(200)
    expect(r.body.summary.totalRevenue).toBe(2000)
    expect(r.body.summary.totalCost).toBe(600)
    expect(r.body.summary.grossProfit).toBe(1400)
  })

  it("leaves a product with no category in Uncategorized", async () => {
    m.ledgerSales = [
      {
        id: "sale-1",
        status: "COMPLETED",
        items: [
          {
            id: "li-1",
            quantity: 1,
            unitPrice: 100,
            costPrice: 50,
            totalPrice: 100,
            product: { id: "p-1", name: "Unknown", sku: null, category: null },
            batch: null,
          },
        ],
      },
    ]
    const r = await getReport("type=profit&period=today")
    expect(r.body.profitByCategory).toHaveLength(1)
    expect(r.body.profitByCategory[0].category).toBe("Uncategorized")
  })
})

describe("GET /api/admin/reports?type=purchases", () => {
  it("does not hand the database error text to the client", async () => {
    m.errors = { pharmacy_purchases: { message: 'relation "pharmacy_purchases" does not exist' } }
    const r = await getReport("type=purchases&period=today")
    expect(r.status).toBe(500)
    expect(r.body.error).toBe("Failed to load purchases")
    expect(JSON.stringify(r.body)).not.toContain("pharmacy_purchases")
  })
})

const voidedSale = (over: Record<string, unknown>) => ({
  id: "sale-cash",
  receipt_number: "R-CASH",
  total_amount: 1900,
  payment_method: "cash",
  payment_ref: "PAID:1000|BAL:900|M:CASH",
  voided_reason: "customer returned the purchase",
  voided_at: "2026-11-01T12:00:00.000Z",
  cashier_id: "c-1",
  ...over,
})

describe("GET /api/admin/reports?type=refunds", () => {
  beforeEach(() => {
    m.data = {
      pharmacy_pos_sales: [
        voidedSale({}),
        voidedSale({
          id: "sale-credit",
          receipt_number: "R-CREDIT",
          payment_method: "credit",
          payment_ref: "PAID:0|BAL:1900|M:CREDIT",
        }),
      ],
      pharmacy_credit_ledger: [
        { idempotency_key: "pos-refund:sale-credit", amount: 1900 },
      ],
      pharmacy_transactions: [{ id: "tx-legacy" }],
      profiles: [{ id: "c-1", full_name: "Amina Nakato" }],
    }
  })

  it("reports cash handed back and credit reversed separately", async () => {
    const r = await getReport("type=refunds&period=today")
    expect(r.status).toBe(200)
    expect(r.body.summary).toMatchObject({
      refundCount: 2,
      cashRefunded: 1000,
      receivableReversed: 1900,
      refundedValue: 2900,
      unpostedReceivables: 1,
      excludedOrderRefunds: 1,
    })
  })

  it("flags the unpaid part of a part-paid sale that never reached the credit ledger", async () => {
    const r = await getReport("type=refunds&period=today")
    const cashRow = r.body.rows.find((row: { saleId: string }) => row.saleId === "sale-cash")
    expect(cashRow).toMatchObject({
      cashRefunded: 1000,
      receivableReversed: 0,
      receivableUnposted: true,
      cashier: "Amina Nakato",
    })
    const creditRow = r.body.rows.find((row: { saleId: string }) => row.saleId === "sale-credit")
    expect(creditRow).toMatchObject({
      cashRefunded: 0,
      receivableReversed: 1900,
      receivableUnposted: false,
    })
  })

  it("treats a fully-paid sale with no payment tag as all cash", async () => {
    m.data = {
      pharmacy_pos_sales: [voidedSale({ payment_ref: null, total_amount: 5000 })],
      pharmacy_credit_ledger: [],
      pharmacy_transactions: [],
    }
    const r = await getReport("type=refunds&period=today")
    expect(r.body.summary.cashRefunded).toBe(5000)
    expect(r.body.summary.receivableReversed).toBe(0)
    expect(r.body.summary.unpostedReceivables).toBe(0)
  })

  it("scopes the refund queries to the caller's tenant", async () => {
    await getReport("type=refunds&period=today")
    for (const table of ["pharmacy_pos_sales", "pharmacy_credit_ledger"]) {
      expect(callsFor(table, "eq").map((c) => c.args)).toContainEqual(["tenant_id", "tenant-1"])
    }
  })
})
