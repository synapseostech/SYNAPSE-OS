import { beforeEach, describe, expect, it, vi } from "vitest"

// Columns that actually exist on public.pharmacy_transactions (local + prod, 2026-10-02).
const TX_COLUMNS = new Set([
  "cashier_id", "client_address", "client_name", "client_phone", "created_at", "customer_id",
  "discount", "id", "is_edited", "net_amount", "notes", "payment_method", "status", "tax",
  "tenant_id", "total_amount", "transaction_no", "updated_at",
])

const selects: Record<string, string> = {}
const ilikeCalls: Array<{ table: string; column: string; pattern: string }> = []
let posRows: Record<string, unknown>[] = []
let txRows: Record<string, unknown>[] = [
  { id: "t1", transaction_no: "TX-1", status: "COMPLETED", total_amount: 1200, discount: 200, tax: 0, net_amount: 1000, created_at: "2026-10-02T10:00:00Z", items: [] },
]

function chain(table: string) {
  const rows =
    table === "pharmacy_transactions"
      ? txRows
      : table === "pharmacy_pos_sales"
        ? posRows
        : []
  const q: any = {
    select: (s: string) => ((selects[table] = s), q),
    eq: () => q, in: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
    ilike: (column: string, pattern: string) => (ilikeCalls.push({ table, column, pattern }), q),
    then: (res: (v: unknown) => unknown) => {
      const s = selects[table] ?? ""
      const top = s.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, "").split(",").map((c) => c.trim()).filter((c) => c && !c.includes(":"))
      const bad = table === "pharmacy_transactions" ? top.filter((c) => !TX_COLUMNS.has(c)) : []
      return Promise.resolve(
        bad.length ? { data: null, error: { message: `column pharmacy_transactions.${bad[0]} does not exist` } } : { data: rows, error: null },
      ).then(res)
    },
  }
  return q
}

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: (t: string) => chain(t) } }))

import { listLedgerSalesForHistory } from "./sale-ledger"

describe("listLedgerSalesForHistory", () => {
  it("only selects columns that exist on pharmacy_transactions and returns order sales", async () => {
    const rows = await listLedgerSalesForHistory({ tenantId: "tenant-1" })
    const order = rows.filter((r) => r.source === "order")
    expect(order).toHaveLength(1)
    expect(order[0]).toMatchObject({ transactionNo: "TX-1", netAmount: 1000, subtotal: 1200, discount: 200 })
  })

  it("carries the cost frozen on a mirrored line, so history reports its own cost", async () => {
    txRows = [
      {
        id: "t1",
        transaction_no: "TX-TALLY-1",
        status: "COMPLETED",
        total_amount: 2000,
        discount: 0,
        tax: 0,
        net_amount: 2000,
        created_at: "2026-02-01T10:00:00Z",
        items: [
          {
            id: "li-1",
            quantity: 5,
            unit_price: 400,
            cost_price: 120,
            total_price: 2000,
            product: { id: "p-1", name: "Amoxicillin", sku: "AMX", cost_price: 380 },
            batch: null,
          },
        ],
      },
    ]

    const rows = await listLedgerSalesForHistory({ tenantId: "tenant-1" })
    expect(rows[0].items[0]).toMatchObject({ costPrice: 120, quantity: 5, totalPrice: 2000 })
    txRows = [
      { id: "t1", transaction_no: "TX-1", status: "COMPLETED", total_amount: 1200, discount: 200, tax: 0, net_amount: 1000, created_at: "2026-10-02T10:00:00Z", items: [] },
    ]
  })
})

const posRow = (over: Record<string, unknown> = {}) => ({
  id: "sale-1",
  receipt_number: "R-0003",
  status: "completed",
  subtotal: 120,
  discount_total: 0,
  tax_amount: 0,
  total_amount: 120,
  payment_method: "CASH",
  payment_ref: "PAID:40|BAL:80|M:CASH",
  cashier_id: "cashier-1",
  created_at: "2026-11-01T10:00:00.000Z",
  print_failed: false,
  items: [],
  ...over,
})

describe("listLedgerSalesForHistory search", () => {
  beforeEach(() => {
    ilikeCalls.length = 0
    posRows = []
  })

  it("matches the receipt number on POS sales and the transaction number on legacy orders", async () => {
    posRows = [posRow()]
    await listLedgerSalesForHistory({ tenantId: "tenant-1", search: "R-0003" })
    expect(ilikeCalls).toEqual([
      { table: "pharmacy_pos_sales", column: "receipt_number", pattern: "%R-0003%" },
      { table: "pharmacy_transactions", column: "transaction_no", pattern: "%R-0003%" },
    ])
  })

  it("escapes LIKE wildcards typed into the search box", async () => {
    await listLedgerSalesForHistory({ tenantId: "tenant-1", search: "50%_x" })
    expect(ilikeCalls.map((c) => c.pattern)).toEqual(["%50\\%\\_x%", "%50\\%\\_x%"])
  })

  it("adds no filter when the search is absent", async () => {
    await listLedgerSalesForHistory({ tenantId: "tenant-1" })
    expect(ilikeCalls).toHaveLength(0)
  })

  it("carries the settlement tag so callers can split cash from credit", async () => {
    posRows = [posRow()]
    const [sale] = await listLedgerSalesForHistory({ tenantId: "tenant-1" })
    expect(sale.paymentRef).toBe("PAID:40|BAL:80|M:CASH")
  })

  it("reports a voided POS sale as REFUNDED", async () => {
    posRows = [posRow({ status: "voided" })]
    const [sale] = await listLedgerSalesForHistory({ tenantId: "tenant-1" })
    expect(sale.status).toBe("REFUNDED")
  })
})
