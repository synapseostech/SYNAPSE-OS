import { describe, expect, it } from "vitest"
import { boundsOf, fakeSupabase, filtersOf } from "@/lib/tally/test-db"
import {
  DATASETS,
  countDataset,
  findDataset,
  readPage,
  type ExportContext,
  type ExportDataset,
} from "./datasets"

function context(rows: Record<string, unknown[]> = {}) {
  const db = fakeSupabase((operation) => ({
    data: rows[operation.table] ?? [],
    error: null,
    count: (rows[operation.table] ?? []).length,
  }))
  const ctx: ExportContext = {
    db: db.client,
    tenantId: "tenant-1",
    from: "2026-01-01",
    to: "2026-01-31",
  }
  return { ctx, operations: db.operations }
}

function dataset(id: string): ExportDataset {
  const found = findDataset(id)
  if (!found) throw new Error(`no dataset ${id}`)
  return found
}

describe("the registry", () => {
  it("offers the categories the owner asked for", () => {
    expect(DATASETS.map((entry) => entry.id)).toEqual([
      "sales",
      "sale-lines",
      "purchases",
      "suppliers",
      "products",
      "stock-adjustments",
      "customers",
      "credit-ledger",
    ])
  })

  it("gives every dataset a unique id and non-empty column list", () => {
    const ids = new Set<string>()
    for (const entry of DATASETS) {
      expect(ids.has(entry.id)).toBe(false)
      ids.add(entry.id)
      expect(entry.columns.length).toBeGreaterThan(0)
      expect(new Set(entry.columns.map((column) => column.key)).size).toBe(entry.columns.length)
      expect(entry.sources.length).toBeGreaterThan(0)
    }
  })

  it("treats only the snapshot exports as unscoped", () => {
    expect(DATASETS.filter((entry) => !entry.dateScoped).map((entry) => entry.id)).toEqual([
      "suppliers",
      "products",
      "customers",
    ])
  })
})

describe("sales", () => {
  const rows = {
    pharmacy_pos_sales: [
      {
        id: "s1",
        receipt_number: "R-1",
        status: "completed",
        subtotal: 100,
        discount_total: 10,
        tax_amount: 5,
        total_amount: 95,
        payment_method: "cash",
        cashier_id: "u1",
        created_at: "2026-01-05T10:00:00Z",
      },
    ],
    pharmacy_transactions: [
      {
        id: "t1",
        transaction_no: "T-1",
        status: "COMPLETED",
        total_amount: 100,
        discount: 10,
        tax: 5,
        payment_method: "CASH",
        client_name: "John Okello",
        client_phone: "+256700000000",
        cashier_id: null,
        created_at: "2026-01-06T10:00:00Z",
      },
    ],
    profiles: [{ id: "u1", full_name: "Amina K" }],
  }

  it("counts both sales sources", async () => {
    const { ctx } = context(rows)
    expect(await countDataset(dataset("sales"), ctx)).toEqual([1, 1])
  })

  it("emits POS sales before Till orders, each with the full column set", async () => {
    const { ctx } = context(rows)
    const page = await readPage(dataset("sales"), ctx, [1, 1], 0, 100)

    expect(page.consumed).toBe(2)
    expect(page.rows.map((row) => row.source)).toEqual(["POS", "Till"])

    const [pos, till] = page.rows
    expect(pos).toMatchObject({
      receiptNumber: "R-1",
      cashier: "Amina K",
      subtotal: 100,
      discount: 10,
      tax: 5,
      total: 95,
    })
    expect(till).toMatchObject({
      receiptNumber: "T-1",
      customer: "John Okello",
      customerPhone: "+256700000000",
      subtotal: 100,
      discount: 10,
      tax: 5,
      total: 95,
    })
  })

  it("reads timestamps on the Kampala business day", async () => {
    const { ctx } = context(rows)
    const page = await readPage(dataset("sales"), ctx, [1, 1], 0, 100)

    // 10:00 UTC is 13:00 in Kampala.
    expect(page.rows[0]?.date).toBe("2026-01-05 13:00")
  })

  it("scopes both sources to the tenant and the date range", async () => {
    const { ctx, operations } = context(rows)
    await readPage(dataset("sales"), ctx, [1, 1], 0, 100)

    const salesQueries = operations.filter((entry) =>
      ["pharmacy_pos_sales", "pharmacy_transactions"].includes(entry.table),
    )
    expect(salesQueries).toHaveLength(2)
    for (const operation of salesQueries) {
      expect(filtersOf(operation).tenant_id).toBe("tenant-1")
      expect(boundsOf(operation).created_at).toEqual({
        gte: "2026-01-01T00:00:00+03:00",
        lte: "2026-01-31T23:59:59.999+03:00",
      })
    }
    expect(
      filtersOf(operations.find((operation) => operation.table === "pharmacy_pos_sales")!).status,
    ).toEqual(["completed", "voided"])
    expect(
      filtersOf(operations.find((operation) => operation.table === "pharmacy_transactions")!).status,
    ).toBe("COMPLETED")
  })

  it("skips past a source that the offset already consumed", async () => {
    const { ctx } = context(rows)
    const page = await readPage(dataset("sales"), ctx, [1, 1], 1, 100)

    expect(page.consumed).toBe(1)
    expect(page.rows.map((row) => row.source)).toEqual(["Till"])
  })

  it("returns nothing once the offset is past every source", async () => {
    const { ctx } = context(rows)
    const page = await readPage(dataset("sales"), ctx, [1, 1], 2, 100)

    expect(page).toEqual({ rows: [], consumed: 0 })
  })
})

describe("products", () => {
  it("emits one row per batch and still shows a product with none", async () => {
    const { ctx } = context({
      pharmacy_products: [
        {
          id: "p1",
          name: "Amoxicillin 250mg",
          sku: "AMX-250",
          is_active: true,
          price: 2000,
          cost_price: 1200,
          quantity: 0,
          pharmacy_product_batches: [
            { batch_number: "B1", quantity: 30, expiry_date: "2027-01-31", cost_price: 1000, selling_price: 2000, is_active: true },
            { batch_number: "B2", quantity: 20, expiry_date: "2027-06-30", cost_price: 1100, selling_price: 2100, is_active: true },
          ],
        },
        {
          id: "p2",
          name: "Paracetamol 500mg",
          sku: "PCM-500",
          is_active: true,
          price: 500,
          cost_price: null,
          quantity: 40,
          expiry_date: "2028-01-01",
          pharmacy_product_batches: [],
        },
      ],
    })

    const page = await readPage(dataset("products"), ctx, [2], 0, 100)

    // Two records read, three rows written.
    expect(page.consumed).toBe(2)
    expect(page.rows).toHaveLength(3)
    expect(page.rows.map((row) => row.batchNumber)).toEqual(["B1", "B2", null])
    expect(page.rows[2]).toMatchObject({
      product: "Paracetamol 500mg",
      quantity: 40,
      costPrice: null,
      expiryDate: "2028-01-01",
      batchActive: null,
    })
  })

  it("counts product records, not the rows they flatten into", async () => {
    const { ctx } = context({ pharmacy_products: [{ id: "p1" }, { id: "p2" }] })
    expect(await countDataset(dataset("products"), ctx)).toEqual([2])
  })
})

describe("purchases", () => {
  it("compares a date column as a date, not a timestamp", async () => {
    const { ctx, operations } = context({ pharmacy_purchases: [] })
    await readPage(dataset("purchases"), ctx, [1], 0, 100)

    expect(boundsOf(operations[0]!).purchase_date).toEqual({
      gte: "2026-01-01",
      lte: "2026-01-31",
    })
    expect(filtersOf(operations[0]!).tenant_id).toBe("tenant-1")
  })

  it("carries the supplier name through the embed", async () => {
    const { ctx } = context({
      pharmacy_purchases: [
        {
          id: "pu1",
          purchase_no: "PO-1",
          purchase_date: "2026-01-10",
          supplier: { name: "Kampala Wholesale" },
          subtotal: 500,
          tax: 0,
          discount: 0,
          other_cost: 0,
          total: 500,
          amount_paid: 200,
          balance: 300,
        },
      ],
    })

    const page = await readPage(dataset("purchases"), ctx, [1], 0, 100)
    expect(page.rows[0]).toMatchObject({
      purchaseNo: "PO-1",
      purchaseDate: "2026-01-10",
      supplier: "Kampala Wholesale",
      total: 500,
      balance: 300,
    })
  })
})

describe("customers", () => {
  it("never asks the database for a password hash", async () => {
    const { ctx, operations } = context({ pharmacy_customers: [] })
    await readPage(dataset("customers"), ctx, [1], 0, 100)

    expect(JSON.stringify(operations[0]!.selected)).not.toContain("password")
  })
})

describe("credit ledger", () => {
  it("carries the customer name through the embed", async () => {
    const { ctx } = context({
      pharmacy_credit_ledger: [
        {
          id: "c1",
          type: "credit",
          amount: 1000,
          balance_after: 1000,
          due_date: "2026-02-15",
          notes: null,
          created_at: "2026-01-20T08:00:00Z",
          customer: { name: "John Okello" },
        },
      ],
    })

    const page = await readPage(dataset("credit-ledger"), ctx, [1], 0, 100)
    expect(page.rows[0]).toMatchObject({
      customer: "John Okello",
      type: "credit",
      amount: 1000,
      balanceAfter: 1000,
      dueDate: "2026-02-15",
    })
  })
})
