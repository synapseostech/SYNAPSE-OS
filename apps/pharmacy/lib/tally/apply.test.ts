import { describe, expect, it } from "vitest"
import type {
  TallyCutoverAccount,
  TallyCutoverPlan,
  TallyCutoverPurchase,
  TallyCutoverSale,
  TallyCutoverVoucher,
} from "@synapse/db/tally-normalise"
import { __test__, applyTallyChunk, emptyProgress, type TallyApplyProgress } from "./apply"
import { isTallyMirrorNote, type TallyApplyDb } from "./types"

type Operation = {
  table: string
  action: "select" | "insert" | "upsert" | "update" | "delete" | "rpc"
  payload?: unknown
  options?: unknown
  filters: Array<[string, unknown]>
}

type Result = { data?: unknown; error?: { message: string } | null }

type Chain = {
  select: (...columns: unknown[]) => Chain
  insert: (payload: unknown) => Chain
  upsert: (payload: unknown, options: unknown) => Chain
  update: (payload: unknown) => Chain
  delete: () => Chain
  eq: (column: string, value: unknown) => Chain
  ilike: (column: string, value: unknown) => Chain
  limit: (count?: number) => Chain
  maybeSingle: () => Promise<Result>
  single: () => Promise<Result>
  then: (
    onFulfilled?: (value: Result) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>
}

function fakeDb(handler: (operation: Operation) => Result | undefined = () => undefined) {
  const operations: Operation[] = []
  const resolve = (operation: Operation) => handler(operation) ?? { data: null, error: null }

  const from = (table: string) => {
    const operation: Operation = { table, action: "select", filters: [] }
    operations.push(operation)
    const chain: Chain = {
      select: () => chain,
      insert: (payload: unknown) => {
        operation.action = "insert"
        operation.payload = payload
        return chain
      },
      upsert: (payload: unknown, options: unknown) => {
        operation.action = "upsert"
        operation.payload = payload
        operation.options = options
        return chain
      },
      update: (payload: unknown) => {
        operation.action = "update"
        operation.payload = payload
        return chain
      },
      delete: () => {
        operation.action = "delete"
        return chain
      },
      eq: (column: string, value: unknown) => {
        operation.filters.push([column, value])
        return chain
      },
      ilike: (column: string, value: unknown) => {
        operation.filters.push([column, value])
        return chain
      },
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resolve(operation)),
      single: () => Promise.resolve(resolve(operation)),
      then: (
        onFulfilled?: (value: Result) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(resolve(operation)).then(onFulfilled, onRejected),
    }
    return chain
  }

  const rpc = (fn: string, args: Record<string, unknown>) => {
    const operation: Operation = {
      table: `rpc:${fn}`,
      action: "rpc",
      payload: args,
      filters: [],
    }
    operations.push(operation)
    return Promise.resolve(resolve(operation))
  }

  return { db: { from, rpc } as unknown as TallyApplyDb, operations }
}

function plan(overrides: Partial<TallyCutoverPlan> = {}): TallyCutoverPlan {
  return {
    company: "Test Pharmacy Ltd",
    companyKey: "company-guid",
    currency: "UGX",
    conversionDate: "2026-04-01",
    mode: "opening",
    accounts: [],
    parties: [],
    stockItems: [],
    stock: {
      openingValue: null,
      closingValue: null,
      itemsWithOpeningValue: 0,
      itemsWithClosingValue: 0,
      itemCount: 0,
    },
    opening: {
      date: "2026-04-01",
      currency: "UGX",
      lines: [],
      totalDebit: 0,
      totalCredit: 0,
      difference: 0,
    },
    vouchers: [],
    sales: [],
    purchases: [],
    exceptions: [],
    counts: {
      ledgers: 0,
      groups: 0,
      stockItems: 0,
      vouchers: 0,
      postedVouchers: 0,
      skippedVouchers: 0,
      sales: 0,
      purchases: 0,
      openingLines: 0,
    },
    warnings: [],
    ...overrides,
  }
}

function account(code: string, overrides: Partial<TallyCutoverAccount> = {}): TallyCutoverAccount {
  const name = overrides.name ?? `Ledger ${code}`
  return {
    sourceName: name,
    code,
    name,
    accountType: "expense",
    normalBalance: "debit",
    role: "expense",
    unclassified: false,
    openingBalance: 0,
    openingSide: "none",
    openingMethod: "none",
    ...overrides,
  }
}

function sale(overrides: Partial<TallyCutoverSale> = {}): TallyCutoverSale {
  return {
    sourceId: "company-guid:voucher-1",
    date: "2025-05-10",
    transactionNumber: "TALLY-S-1",
    paymentMethod: "CASH",
    total: 100,
    tax: 0,
    discount: 0,
    items: [{ stockItemName: "Test Item A", quantity: 2, unitPrice: 50, lineTotal: 100 }],
    ...overrides,
  }
}

function purchase(overrides: Partial<TallyCutoverPurchase> = {}): TallyCutoverPurchase {
  return {
    sourceId: "company-guid:voucher-2",
    date: "2025-05-11",
    purchaseNumber: "TALLY-P-1",
    partyName: "Test Supplier",
    total: 200,
    tax: 0,
    amountPaid: 0,
    paymentMethod: "CASH",
    items: [{ stockItemName: "Test Item A", quantity: 4, unitCost: 50, lineTotal: 200 }],
    ...overrides,
  }
}

function voucher(overrides: Partial<TallyCutoverVoucher> = {}): TallyCutoverVoucher {
  return {
    sourceId: "company-guid:voucher-1",
    sourceType: "PHARMACY_SALE",
    kind: "sales",
    date: "2025-05-10",
    description: "Sale TALLY-S-1",
    currency: "UGX",
    lines: [
      { accountCode: "1000", accountName: "Cash-in-Hand", debit: 100, credit: 0 },
      { accountCode: "4000", accountName: "Sales", debit: 0, credit: 100 },
    ],
    ...overrides,
  }
}

const PRODUCT = { id: "product-1", sku: "TALLY-1", name: "Test Item A" }

/** What a row created by this importer carries on replay. */
const MIRROR_NOTE = "Imported from Tally (Test Pharmacy Ltd) — read-only"

function journalsProgress(): TallyApplyProgress {
  return { ...emptyProgress(), stage: "journals" }
}

describe("stageAccounts", () => {
  it("seeds the system chart before writing Tally ledgers", async () => {
    const { db, operations } = fakeDb((operation) => {
      if (operation.action === "rpc" && operation.table === "rpc:add_pharmacy_accounting_accounts") {
        return { data: 1, error: null }
      }
      if (operation.table === "pharmacy_accounting_accounts" && operation.action === "select") {
        return { data: [{ id: "account-1000", code: "1000" }], error: null }
      }
      return undefined
    })

    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({
        accounts: [
          account("1000", { systemKey: "CASH_ON_HAND", name: "Cash-in-Hand" }),
          account("T-1", { name: "Test Bank" }),
        ],
      }),
      progress: emptyProgress(),
    })

    expect(operations[0]).toMatchObject({
      table: "rpc:seed_pharmacy_accounting_accounts",
      action: "rpc",
      payload: { p_tenant_id: "tenant-1" },
    })

    const written = operations.find(
      (operation) => operation.table === "rpc:add_pharmacy_accounting_accounts",
    )
    expect((written?.payload as { p_accounts: Array<{ code: string }> }).p_accounts.map((row) => row.code)).toEqual([
      "T-1",
    ])
    expect(operations.some((operation) => operation.action === "insert")).toBe(false)
    expect(result.progress.counts.accounts).toBe(1)
    expect(result.progress.stage).toBe("parties")
  })

  it("stops when the chart cannot be seeded", async () => {
    const { db, operations } = fakeDb((operation) =>
      operation.action === "rpc"
        ? { data: null, error: { message: "ACCOUNTING_TENANT_NOT_FOUND" } }
        : undefined,
    )

    await expect(
      applyTallyChunk(db, {
        tenantId: "tenant-1",
        actorId: "user-1",
        plan: plan({ accounts: [account("T-1")] }),
        progress: emptyProgress(),
      }),
    ).rejects.toThrow("ACCOUNTING_TENANT_NOT_FOUND")
    expect(
      operations.some((operation) => operation.table === "rpc:add_pharmacy_accounting_accounts"),
    ).toBe(false)
  })

  it("reports the rows the database actually inserted", async () => {
    const { db } = fakeDb((operation) => {
      if (operation.action === "rpc" && operation.table === "rpc:add_pharmacy_accounting_accounts") {
        return { data: 0, error: null }
      }
      return undefined
    })

    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ accounts: [account("T-1"), account("T-2")] }),
      progress: emptyProgress(),
    })

    expect(result.progress.counts.accounts).toBe(0)
  })
})

describe("stageProducts", () => {
  it("reuses a portal product whose name differs only in whitespace", async () => {
    const { db, operations } = fakeDb((operation) => {
      if (operation.action !== "select" || operation.table !== "pharmacy_products") return undefined
      // Stand in for ILIKE: an exact name finds the row, a whitespace variant does not.
      const nameFilter = operation.filters.find(([column]) => column === "name")
      if (nameFilter && nameFilter[1] !== "Test Item A") return { data: [], error: null }
      return {
        data: [
          {
            id: "product-1",
            sku: "TALLY-1",
            name: "Test Item A",
            strength: null,
            dosage_form: null,
            active_ingredient: null,
          },
        ],
        error: null,
      }
    })

    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({
        stockItems: [
          {
            sourceName: "Test  Item A",
            sku: "TALLY-2",
            name: "Test  Item A",
            batches: [],
          },
        ],
      }),
      progress: { ...emptyProgress(), stage: "products" },
    })

    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_products" && operation.action === "insert",
      ),
    ).toBe(false)
  })
})

describe("opening journal", () => {
  it("does not advance to opening stock when the opening does not balance", async () => {
    const { db, operations } = fakeDb()
    const balanced = plan()
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: { ...balanced, opening: { ...balanced.opening, difference: 250 } },
      progress: { ...emptyProgress(), stage: "opening-journal" },
    })

    expect(result.progress.stage).toBe("opening-journal")
    expect(result.done).toBe(false)
    expect(result.progress.failures).toEqual([
      expect.objectContaining({ code: "OPENING_DIFFERENCE" }),
    ])
    expect(operations.some((operation) => operation.action === "rpc")).toBe(false)
  })
})

describe("reporting mirrors", () => {
  function mirrorDb(options: {
    parent?: unknown[]
    children?: unknown[]
    purchasesParent?: unknown[]
    purchasesChildren?: unknown[]
    accounts?: unknown[]
    journalError?: string
    upsertData?: unknown[]
  }) {
    return fakeDb((operation) => {
      if (operation.action === "rpc" && options.journalError) {
        return { data: null, error: { message: options.journalError } }
      }
      if (operation.action === "select") {
        if (operation.table === "pharmacy_accounting_accounts") {
          return { data: options.accounts ?? [], error: null }
        }
        if (operation.table === "pharmacy_products") return { data: [PRODUCT], error: null }
        if (operation.table === "pharmacy_suppliers") {
          return { data: [{ id: "supplier-1", name: "Test Supplier" }], error: null }
        }
        if (operation.table === "pharmacy_transactions") {
          return { data: options.parent ?? [], error: null }
        }
        if (operation.table === "pharmacy_transaction_items") {
          return { data: options.children ?? [], error: null }
        }
        if (operation.table === "pharmacy_purchases") {
          return { data: options.purchasesParent ?? [], error: null }
        }
        if (operation.table === "pharmacy_purchase_items") {
          return { data: options.purchasesChildren ?? [], error: null }
        }
        return { data: [], error: null }
      }
      if (operation.action === "upsert") return { data: options.upsertData ?? [], error: null }
      return { data: null, error: null }
    })
  }

  it("repairs a sale whose parent mirror exists but has no items", async () => {
    const { db, operations } = mirrorDb({
      parent: [
        { id: "transaction-1", notes: MIRROR_NOTE, total_amount: 100, discount: 0, tax: 0 },
      ],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    const items = operations.find(
      (operation) =>
        operation.table === "pharmacy_transaction_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([
      expect.objectContaining({ transaction_id: "transaction-1", product_id: "product-1" }),
    ])
    expect(result.progress.counts.sales).toBe(1)
  })

  it("leaves a complete sale mirror alone on replay", async () => {
    const { db, operations } = mirrorDb({
      parent: [
        { id: "transaction-1", notes: MIRROR_NOTE, total_amount: 100, discount: 0, tax: 0 },
      ],
      children: [{ id: "item-1" }],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_transaction_items" && operation.action === "insert",
      ),
    ).toBe(false)
    expect(result.progress.counts.sales).toBe(0)
  })

  it("reports a second Tally voucher reusing a sale number instead of mixing them", async () => {
    const { db, operations } = mirrorDb({
      parent: [
        { id: "transaction-1", notes: MIRROR_NOTE, total_amount: 999, discount: 0, tax: 0 },
      ],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_transaction_items" && operation.action === "insert",
      ),
    ).toBe(false)
    expect(result.progress.counts.sales).toBe(0)
    expect(result.progress.failures).toEqual([
      expect.objectContaining({ code: "SALE_NUMBER_COLLISION", key: "company-guid:voucher-1" }),
    ])
  })

  it("mirrors a purchase in the plan currency and repairs missing items", async () => {
    const { db, operations } = mirrorDb({
      purchasesParent: [
        { id: "purchase-1", notes: MIRROR_NOTE, total: 200, tax: 0, amount_paid: 0 },
      ],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ currency: "KES", purchases: [purchase()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [], purchases: [purchase()] },
      totalChunks: 2,
    })

    const parent = operations.find(
      (operation) => operation.table === "pharmacy_purchases" && operation.action === "upsert",
    )
    expect(parent?.payload).toEqual([expect.objectContaining({ currency: "KES" })])

    const items = operations.find(
      (operation) => operation.table === "pharmacy_purchase_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([
      expect.objectContaining({ purchase_id: "purchase-1", product_name: "Test Item A" }),
    ])
    expect(result.progress.counts.purchases).toBe(1)
  })

  it("reports a second Tally voucher reusing a purchase number instead of mixing them", async () => {
    const { db, operations } = mirrorDb({
      purchasesParent: [
        { id: "purchase-1", notes: MIRROR_NOTE, total: 999, tax: 0, amount_paid: 0 },
      ],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ purchases: [purchase()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [], purchases: [purchase()] },
      totalChunks: 2,
    })

    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_purchase_items" && operation.action === "insert",
      ),
    ).toBe(false)
    expect(result.progress.counts.purchases).toBe(0)
    expect(result.progress.failures).toEqual([
      expect.objectContaining({ code: "PURCHASE_NUMBER_COLLISION", key: "company-guid:voucher-2" }),
    ])
  })

  it("leaves the cost of an imported sale line unknown", async () => {
    const { db, operations } = mirrorDb({
      parent: [
        { id: "transaction-1", notes: MIRROR_NOTE, total_amount: 100, discount: 0, tax: 0 },
      ],
    })
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    const items = operations.find(
      (operation) =>
        operation.table === "pharmacy_transaction_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([expect.objectContaining({ cost_price: null })])
  })

  it("mirrors net_amount as what the customer owed, not the pre-tax total", async () => {
    // The import used to store sale.total here, which made an imported row mean
    // something different from an edited one. See lib/pos/net-amount.ts.
    const { db, operations } = mirrorDb({})
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: {
        vouchers: [],
        sales: [sale({ total: 1000, tax: 180, discount: 100 })],
        purchases: [],
      },
      totalChunks: 2,
    })

    const parent = operations.find(
      (operation) => operation.table === "pharmacy_transactions" && operation.action === "upsert",
    )
    expect((parent?.payload as Array<Record<string, number>>)[0]).toMatchObject({
      total_amount: 1000,
      discount: 100,
      tax: 180,
      net_amount: 1080,
    })
  })

  it("stamps the note the purchases API uses to refuse edits", async () => {
    const { db, operations } = mirrorDb({
      purchasesParent: [
        { id: "purchase-1", notes: MIRROR_NOTE, total: 200, tax: 0, amount_paid: 0 },
      ],
    })
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ purchases: [purchase()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [], purchases: [purchase()] },
      totalChunks: 2,
    })

    const parent = operations.find(
      (operation) => operation.table === "pharmacy_purchases" && operation.action === "upsert",
    )
    const notes = (parent?.payload as Array<{ notes: string }>)[0].notes
    expect(isTallyMirrorNote(notes)).toBe(true)
  })

  it("leaves a portal sale alone and reports the collision", async () => {
    const { db, operations } = mirrorDb({ parent: [{ id: "transaction-1", notes: "Walk-in sale" }] })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    expect(result.progress.failures).toEqual([expect.objectContaining({ code: "SALE_CONFLICT" })])
    expect(result.progress.counts.sales).toBe(0)
    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_transaction_items" && operation.action === "insert",
      ),
    ).toBe(false)
  })

  it("leaves a portal purchase alone and reports the collision", async () => {
    const { db, operations } = mirrorDb({
      purchasesParent: [{ id: "purchase-1", notes: "Entered in the portal" }],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ purchases: [purchase()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [], purchases: [purchase()] },
      totalChunks: 2,
    })

    expect(result.progress.failures).toEqual([
      expect.objectContaining({ code: "PURCHASE_CONFLICT" }),
    ])
    expect(result.progress.counts.purchases).toBe(0)
    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_purchase_items" && operation.action === "insert",
      ),
    ).toBe(false)
  })

  it("records the same failure once across retries", async () => {
    const { db } = mirrorDb({})
    const progress = journalsProgress()
    const chunk = {
      vouchers: [],
      sales: [sale({ items: [{ stockItemName: "Unknown Item", quantity: 1, unitPrice: 10, lineTotal: 10 }] })],
      purchases: [],
    }
    const input = {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: chunk.sales }),
      progress,
      chunk,
      totalChunks: 2,
    }

    await applyTallyChunk(db, input)
    const result = await applyTallyChunk(db, input)

    expect(
      result.progress.failures.filter((failure) => failure.code === "PRODUCT_MISSING"),
    ).toHaveLength(1)
  })

  it("links a sale line whose Tally name differs only in whitespace", async () => {
    const { db, operations } = mirrorDb({
      parent: [
        { id: "transaction-1", notes: MIRROR_NOTE, total_amount: 100, discount: 0, tax: 0 },
      ],
    })
    const variant = sale({
      items: [{ stockItemName: "Test  Item A", quantity: 1, unitPrice: 100, lineTotal: 100 }],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [variant] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [variant], purchases: [] },
      totalChunks: 2,
    })

    const items = operations.find(
      (operation) =>
        operation.table === "pharmacy_transaction_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([
      expect.objectContaining({ product_id: "product-1", quantity: 1 }),
    ])
    expect(result.progress.failures).toEqual([])
  })

  it("links a purchase line whose Tally name differs only in whitespace", async () => {
    const { db, operations } = mirrorDb({
      purchasesParent: [
        { id: "purchase-1", notes: MIRROR_NOTE, total: 200, tax: 0, amount_paid: 0 },
      ],
    })
    const variant = purchase({
      items: [{ stockItemName: "Test  Item A", quantity: 1, unitCost: 200, lineTotal: 200 }],
    })
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ purchases: [variant] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [], purchases: [variant] },
      totalChunks: 2,
    })

    const items = operations.find(
      (operation) =>
        operation.table === "pharmacy_purchase_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([expect.objectContaining({ product_id: "product-1" })])
  })

  const accounts = () => [
    { id: "account-1000", code: "1000" },
    { id: "account-4000", code: "4000" },
  ]

  it("does not mirror a sale whose ledger journal the books refused", async () => {
    const { db, operations } = mirrorDb({
      accounts: accounts(),
      journalError: "ACCOUNTING_PERIOD_CLOSED",
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [voucher()], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    expect(result.progress.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SALE_JOURNAL_NOT_POSTED" })]),
    )
    expect(result.progress.counts.sales).toBe(0)
    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_transactions" && operation.action === "upsert",
      ),
    ).toBe(false)
  })

  it("does not mirror a purchase whose ledger journal the books refused", async () => {
    const { db, operations } = mirrorDb({
      accounts: accounts(),
      journalError: "ACCOUNTING_PERIOD_CLOSED",
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ purchases: [purchase()] }),
      progress: journalsProgress(),
      chunk: {
        vouchers: [
          voucher({
            sourceId: "company-guid:voucher-2",
            sourceType: "PHARMACY_PURCHASE",
            kind: "purchase",
            description: "Purchase TALLY-P-1",
            lines: [
              { accountCode: "1000", accountName: "Cash-in-Hand", debit: 0, credit: 200 },
              { accountCode: "4000", accountName: "Purchases", debit: 200, credit: 0 },
            ],
          }),
        ],
        sales: [],
        purchases: [purchase()],
      },
      totalChunks: 2,
    })

    expect(result.progress.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PURCHASE_JOURNAL_NOT_POSTED" })]),
    )
    expect(result.progress.counts.purchases).toBe(0)
    expect(
      operations.some(
        (operation) => operation.table === "pharmacy_purchases" && operation.action === "upsert",
      ),
    ).toBe(false)
  })

  it("mirrors a sale once its journal posts", async () => {
    const { db, operations } = mirrorDb({
      accounts: accounts(),
      upsertData: [{ id: "transaction-1" }],
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ sales: [sale()] }),
      progress: journalsProgress(),
      chunk: { vouchers: [voucher()], sales: [sale()], purchases: [] },
      totalChunks: 2,
    })

    expect(
      result.progress.failures.some((failure) => failure.code === "SALE_JOURNAL_NOT_POSTED"),
    ).toBe(false)
    expect(result.progress.counts.journals).toBe(1)
    expect(result.progress.counts.sales).toBe(1)
    expect(
      operations.some(
        (operation) =>
          operation.table === "pharmacy_transactions" && operation.action === "upsert",
      ),
    ).toBe(true)
  })
})

describe("Progress", () => {
  it("reports the failure cap instead of silently dropping the tail", () => {
    const progress = new __test__.Progress(emptyProgress())
    for (let index = 0; index < 205; index += 1) {
      progress.fail("journals", `voucher-${index}`, "BOOM", "failed")
    }

    expect(progress.value.failures).toHaveLength(201)
    expect(progress.value.failures.slice(0, 200)).toEqual(
      Array.from({ length: 200 }, (_, index) =>
        expect.objectContaining({ key: `voucher-${index}` }),
      ),
    )
    expect(progress.value.failures.at(-1)).toMatchObject({
      code: "FAILURES_TRUNCATED",
      key: "apply",
    })
  })

  it("keeps one truncation entry no matter how many failures follow", () => {
    const progress = new __test__.Progress(emptyProgress())
    for (let index = 0; index < 500; index += 1) {
      progress.fail("journals", `voucher-${index}`, "BOOM", "failed")
    }

    expect(
      progress.value.failures.filter((failure) => failure.code === "FAILURES_TRUNCATED"),
    ).toHaveLength(1)
  })
})
