import { describe, expect, it } from "vitest"
import type {
  TallyCutoverAccount,
  TallyCutoverMovement,
  TallyCutoverPlan,
  TallyCutoverPurchase,
  TallyCutoverSale,
  TallyCutoverVoucher,
} from "@synapse/db/tally-normalise"
import type { TallyReplayCheckpoint } from "@synapse/db/tally-replay-rpc"
import { __test__, applyTallyChunk, emptyProgress, type TallyApplyProgress } from "./apply"
import { isTallyMirrorNote, type TallyApplyDb, type TallyReplayTarget } from "./types"

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
  is: (column: string, value: unknown) => Chain
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
      is: (column: string, value: unknown) => {
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

  it("writes the cost the replay derived for each sale line", async () => {
    const { db, operations } = mirrorDb({ upsertData: [{ id: "transaction-1" }] })
    const line = {
      stockItemName: "Test Item A",
      quantity: 2,
      unitPrice: 50,
      lineTotal: 100,
      lineIndex: 0,
    }
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ mode: "replay", sales: [sale({ items: [line] })] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale({ items: [line] })], purchases: [] },
      totalChunks: 2,
      sessionId: "session-1",
      replay: true,
      replayTarget: {
        costs: { "company-guid:voucher-1:L0": { amount: 50, complete: true } },
      } as TallyReplayTarget,
    })

    const items = operations.find(
      (operation) =>
        operation.table === "pharmacy_transaction_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([expect.objectContaining({ cost_price: 25 })])
  })

  it("leaves the cost unknown when the replay could not cost the line", async () => {
    const { db, operations } = mirrorDb({ upsertData: [{ id: "transaction-1" }] })
    const line = {
      stockItemName: "Test Item A",
      quantity: 2,
      unitPrice: 50,
      lineTotal: 100,
      lineIndex: 0,
    }
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      plan: plan({ mode: "replay", sales: [sale({ items: [line] })] }),
      progress: journalsProgress(),
      chunk: { vouchers: [], sales: [sale({ items: [line] })], purchases: [] },
      totalChunks: 2,
      sessionId: "session-1",
      replay: true,
      replayTarget: {
        costs: { "company-guid:voucher-1:L0": { amount: 50, complete: false } },
      } as TallyReplayTarget,
    })

    const items = operations.find(
      (operation) =>
        operation.table === "pharmacy_transaction_items" && operation.action === "insert",
    )
    expect(items?.payload).toEqual([expect.objectContaining({ cost_price: null })])
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

function stockItem(overrides: Partial<TallyCutoverPlan["stockItems"][number]> = {}) {
  return {
    sourceName: "Test Item A",
    sku: "TALLY-1",
    name: "Test Item A",
    batches: [],
    ...overrides,
  }
}

function movement(overrides: Partial<TallyCutoverMovement> = {}): TallyCutoverMovement {
  return {
    movementId: "company-guid:voucher-2:L0:B0",
    sourceId: "company-guid:voucher-2",
    kind: "purchase",
    movementKind: "purchase_in",
    date: "2026-04-02",
    sourceOrder: 1,
    lineIndex: 0,
    batchIndex: 0,
    stockItemName: "Test Item A",
    quantityDelta: 5,
    batchNumber: "B-1",
    expiryDate: "2026-12-31",
    rate: 10,
    amount: 50,
    allocation: "explicit",
    ...overrides,
  }
}

function replayTarget(overrides: Partial<TallyReplayTarget> = {}): TallyReplayTarget {
  return {
    preparedAt: "2026-04-01T00:00:00.000Z",
    conversionDate: "2026-04-01",
    cutoffDate: "2026-09-30",
    ordering: "date-then-export-order",
    eventCount: 0,
    movementCount: 0,
    perDay: [],
    reconciliation: [],
    totals: { match: 0, difference: 0, notAvailable: 0 },
    blocking: 0,
    warnings: 0,
    findings: [],
    simulated: {
      accounts: {},
      items: [],
      sourceIdsByItem: {},
      sourceIdsByAccount: {},
      eventCount: 0,
    },
    ...overrides,
  }
}

/** A replay plan always carries the stock items the movements name. */
function replayPlan(movements: TallyCutoverMovement[], overrides: Partial<TallyCutoverPlan> = {}) {
  return plan({ stockItems: [stockItem()], movements, ...overrides })
}

type StoredBatch = { quantity: number; expiryDate: string | null; receivedDate: string }

/**
 * A stand-in for `apply_pharmacy_tally_replay_movement` that keeps the one
 * promise the write path depends on: a movement whose provenance is already
 * recorded moves no stock. The real function does this inside one transaction;
 * this fake validates every allocation first and only then mutates, so a
 * refusal leaves the state untouched in the same way.
 */
function replayDb(seed?: {
  batches?: Array<[string, StoredBatch]>
  quantity?: number
  accounts?: Array<{ code: string; debit: number; credit: number }>
  /** Makes the checkpoint RPC refuse, to prove a close cannot outrun it. */
  checkpointError?: string
}) {
  const state = {
    products: new Map<string, number>([["product-1", seed?.quantity ?? 0]]),
    batches: new Map<string, StoredBatch>(seed?.batches ?? []),
    seen: new Set<string>(),
    calls: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    /** Keyed like the RPC: one checkpoint per company and cutoff. */
    checkpoints: new Map<string, Record<string, unknown>>(),
    checkpointCalls: [] as Array<Record<string, unknown>>,
  }

  const { db, operations } = fakeDb((operation) => {
    if (operation.action === "rpc" && operation.table === "rpc:apply_pharmacy_tally_replay_movement") {
      const args = operation.payload as Record<string, any>
      const allocations = (args.p_allocations ?? []) as Array<Record<string, any>>
      // Keyed like the migration: a voucher line with several batch
      // allocations is several movements, so the barrier names the movement's
      // first allocation rather than the whole line.
      const firstBatchIndex = Number(allocations[0]?.batch_index ?? 0)
      const key = `${args.p_source_type}|${args.p_source_id}|${args.p_line_index}|${firstBatchIndex}`
      const productId = String(args.p_product_id)

      if (state.seen.has(key)) {
        return {
          data: {
            replayed: true,
            movement_id: args.p_movement_id,
            allocations: [],
            product_quantity_after: null,
          },
          error: null,
        }
      }

      state.calls.push(args)

      const drafts = allocations.map((allocation) => {
        const batchKey = `${productId}|${allocation.batch_number}`
        const existing = state.batches.get(batchKey)
        return {
          allocation,
          batchKey,
          existing,
          delta: Number(allocation.quantity_delta),
          quantity: (existing?.quantity ?? 0) + Number(allocation.quantity_delta),
        }
      })

      const refused = drafts.find((draft) => draft.quantity < 0 && args.p_allow_negative !== true)
      if (refused) {
        return {
          data: null,
          error: {
            message: `REPLAY_NEGATIVE_STOCK: batch ${refused.allocation.batch_number} would fall to ${refused.quantity}.`,
          },
        }
      }

      const applied = drafts.map((draft) => {
        state.batches.set(draft.batchKey, {
          quantity: draft.quantity,
          expiryDate: (draft.allocation.expiry_date as string | null) ?? null,
          receivedDate: draft.existing?.receivedDate ?? String(args.p_movement_date),
        })
        return {
          batch_id: `batch:${draft.batchKey}`,
          batch_number: draft.allocation.batch_number,
          batch_index: draft.allocation.batch_index,
          quantity_delta: draft.delta,
          quantity_after: draft.quantity,
        }
      })
      const total = drafts.reduce((sum, draft) => sum + draft.delta, 0)
      state.products.set(productId, (state.products.get(productId) ?? 0) + total)
      state.seen.add(key)

      return {
        data: {
          replayed: false,
          movement_id: args.p_movement_id,
          allocations: applied,
          product_quantity_after: state.products.get(productId),
        },
        error: null,
      }
    }

    if (
      operation.action === "rpc" &&
      operation.table === "rpc:record_pharmacy_tally_replay_checkpoint"
    ) {
      const args = operation.payload as Record<string, any>
      state.checkpointCalls.push(args)
      if (seed?.checkpointError) {
        return { data: null, error: { message: seed.checkpointError } }
      }
      const key = `${String(args.p_company_key)}|${String(args.p_through_date)}`
      const existing = state.checkpoints.get(key)
      if (existing) return { data: { ...existing, created: false }, error: null }
      const row = {
        id: `checkpoint-${state.checkpoints.size + 1}`,
        previous_id: null,
        through_date: args.p_through_date,
        company_key: args.p_company_key,
      }
      state.checkpoints.set(key, row)
      return { data: { ...row, created: true }, error: null }
    }

    if (operation.action === "rpc" && operation.table === "rpc:pharmacy_tally_replay_actuals") {
      const products = [...state.products.entries()].map(([productId, quantity]) => ({
        product_id: productId,
        name: "Test Item A",
        quantity,
      }))
      const batches = [...state.batches.entries()].map(([key, batch]) => {
        const [productId, batchNumber] = key.split("|")
        return {
          product_id: productId,
          batch_number: batchNumber,
          expiry_date: batch.expiryDate,
          quantity: batch.quantity,
        }
      })
      const accounts = (seed?.accounts ?? []).map((account) => ({
        account_id: `account-${account.code}`,
        code: account.code,
        name: `Ledger ${account.code}`,
        normal_balance: "credit",
        debit: account.debit,
        credit: account.credit,
      }))
      return { data: { products, batches, accounts, parties: [] }, error: null }
    }

    if (operation.action === "select" && operation.table === "pharmacy_products") {
      const id = operation.filters.find(([column]) => column === "id")?.[1]
      if (typeof id === "string") {
        return { data: [{ quantity: state.products.get(id) ?? 0 }], error: null }
      }
      return { data: [PRODUCT], error: null }
    }

    if (operation.action === "select" && operation.table === "pharmacy_product_batches") {
      const productId = operation.filters.find(([column]) => column === "product_id")?.[1]
      const rows = [...state.batches.entries()]
        .filter(([key]) => key.startsWith(`${String(productId)}|`))
        .map(([key, batch]) => ({
          batch_number: key.split("|")[1],
          expiry_date: batch.expiryDate,
          received_date: batch.receivedDate,
          quantity: batch.quantity,
        }))
      return { data: rows, error: null }
    }

    if (operation.table === "pharmacy_audit_logs") {
      if (operation.action === "insert") {
        state.audits.push(operation.payload as Record<string, unknown>)
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }

    return undefined
  })

  return { db, operations, state }
}

function stockHistoryProgress(): TallyApplyProgress {
  return { ...emptyProgress(), stage: "stock-history" }
}

describe("replay write path", () => {
  it("applies a movement once and treats a second send as already replayed", async () => {
    const { db, state } = replayDb()
    const input = {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([movement()]),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    }

    const first = await applyTallyChunk(db, { ...input, progress: stockHistoryProgress() })
    expect(first.progress.counts.stockMovements).toBe(1)
    expect(first.progress.stage).toBe("journals")
    expect(state.products.get("product-1")).toBe(5)
    expect(state.batches.size).toBe(1)

    // The crash landed between the RPC and the checkpoint save, so the session
    // still resumes at the same chunk and the movement is not applied twice.
    const second = await applyTallyChunk(db, { ...input, progress: stockHistoryProgress() })
    expect(second.progress.counts.movementsReplayed).toBe(1)
    expect(second.progress.counts.stockMovements).toBe(0)
    expect(state.products.get("product-1")).toBe(5)
    expect(state.batches.size).toBe(1)
    expect(state.batches.get("product-1|B-1")).toMatchObject({ quantity: 5 })
  })

  it("resumes at the next movement chunk", async () => {
    const { db, state } = replayDb()
    const movements = [
      movement({ movementId: "m-1", sourceId: "v-1", sourceOrder: 1, batchNumber: "B-1" }),
      movement({
        movementId: "m-2",
        sourceId: "v-2",
        sourceOrder: 2,
        date: "2026-04-03",
        batchNumber: "B-2",
      }),
    ]
    const base = {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      movementTotalChunks: 2,
      replayTarget: replayTarget(),
    }

    const first = await applyTallyChunk(db, {
      ...base,
      progress: stockHistoryProgress(),
      plan: replayPlan([movements[0]!]),
    })
    expect(first.progress).toMatchObject({ stage: "stock-history", offset: 1 })
    expect(first.done).toBe(false)

    const second = await applyTallyChunk(db, {
      ...base,
      progress: first.progress,
      plan: replayPlan([movements[1]!]),
    })
    expect(second.progress).toMatchObject({ stage: "journals", offset: 0 })
    expect(state.products.get("product-1")).toBe(10)
    expect(state.batches.size).toBe(2)
  })

  it("refuses a sale that would take stock below zero and records it against the movement", async () => {
    const { db, state } = replayDb()
    const out = movement({
      movementId: "company-guid:voucher-9:L0:B0",
      sourceId: "company-guid:voucher-9",
      kind: "sales",
      movementKind: "sale_out",
      quantityDelta: -4,
      batchNumber: undefined,
      expiryDate: undefined,
      allocation: "fefo",
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([out]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    })

    expect(result.progress.failures).toEqual([
      expect.objectContaining({
        stage: "stock-history",
        key: out.movementId,
        code: "REPLAY_NEGATIVE_STOCK",
      }),
    ])
    expect(result.progress.counts.stockMovements).toBe(0)
    expect(state.products.get("product-1")).toBe(0)
    expect(state.batches.size).toBe(0)
  })

  it("writes the shortage only where the review acknowledged it", async () => {
    const { db, state } = replayDb()
    const out = movement({
      movementId: "company-guid:voucher-9:L0:B0",
      sourceId: "company-guid:voucher-9",
      kind: "sales",
      movementKind: "sale_out",
      quantityDelta: -4,
      batchNumber: undefined,
      expiryDate: undefined,
      allocation: "fefo",
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([out]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget({
        findings: [
          {
            code: "REPLAY_NEGATIVE_STOCK",
            severity: "blocking",
            date: out.date,
            sourceId: out.sourceId,
            movementId: out.movementId,
            stockItemName: out.stockItemName,
            quantityBefore: 0,
            quantityAfter: -4,
            message: "short by 4",
          },
        ],
      }),
    })

    expect(result.progress.failures).toEqual([])
    expect(result.progress.counts.stockMovements).toBe(1)
    expect(state.batches.get("product-1|TALLY-RPL-NEGATIVE")).toMatchObject({ quantity: -4 })
    expect(state.products.get("product-1")).toBe(-4)
  })

  it("takes a physical count down against the batches that hold the stock", async () => {
    const { db, state } = replayDb({
      quantity: 135,
      batches: [
        ["product-1|B-1", { quantity: 100, expiryDate: "2026-06-30", receivedDate: "2025-12-01" }],
        ["product-1|B-2", { quantity: 35, expiryDate: "2027-01-31", receivedDate: "2026-01-01" }],
      ],
    })
    const count = movement({
      movementId: "company-guid:voucher-30:L0:B0",
      sourceId: "company-guid:voucher-30",
      kind: "stock-journal",
      movementKind: "physical_adjust",
      quantityDelta: 120,
      batchNumber: undefined,
      expiryDate: undefined,
      allocation: "fefo",
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([count]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    })

    expect(result.progress.failures).toEqual([])
    // The line states the count, so 15 units leave the batch a sale would have
    // taken them from, and no batch is invented for the shortfall.
    expect(state.products.get("product-1")).toBe(120)
    expect(state.batches.get("product-1|B-1")).toMatchObject({ quantity: 85 })
    expect(state.batches.get("product-1|B-2")).toMatchObject({ quantity: 35 })
    expect(state.batches.has("product-1|TALLY-RPL-PHYSICAL")).toBe(false)
  })

  it("books a physical count above the books into the physical-count bucket", async () => {
    const { db, state } = replayDb({
      quantity: 5,
      batches: [
        ["product-1|B-1", { quantity: 5, expiryDate: "2026-06-30", receivedDate: "2025-12-01" }],
      ],
    })
    const count = movement({
      movementId: "company-guid:voucher-31:L0:B0",
      sourceId: "company-guid:voucher-31",
      kind: "stock-journal",
      movementKind: "physical_adjust",
      quantityDelta: 9,
      batchNumber: undefined,
      expiryDate: undefined,
      allocation: "fefo",
    })
    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([count]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    })

    expect(result.progress.failures).toEqual([])
    expect(state.products.get("product-1")).toBe(9)
    expect(state.batches.get("product-1|B-1")).toMatchObject({ quantity: 5 })
    expect(state.batches.get("product-1|TALLY-RPL-PHYSICAL")).toMatchObject({ quantity: 4 })
  })

  it("does not take a sale off a batch that had already expired on its day", async () => {
    const { db, state } = replayDb({
      quantity: 10,
      batches: [
        ["product-1|B-OLD", { quantity: 5, expiryDate: "2026-01-31", receivedDate: "2026-01-01" }],
        ["product-1|B-NEW", { quantity: 5, expiryDate: "2026-12-31", receivedDate: "2026-02-01" }],
      ],
    })
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([
        movement({
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-03-01",
          quantityDelta: -3,
          batchNumber: undefined,
          expiryDate: undefined,
          allocation: "fefo",
        }),
      ]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    })

    expect(state.batches.get("product-1|B-OLD")).toMatchObject({ quantity: 5 })
    expect(state.batches.get("product-1|B-NEW")).toMatchObject({ quantity: 2 })
  })

  it("splits one sale across batches in a single call, earliest expiry first", async () => {
    const { db, state } = replayDb({
      quantity: 7,
      batches: [
        ["product-1|B-JUN", { quantity: 2, expiryDate: "2026-06-30", receivedDate: "2026-02-01" }],
        ["product-1|B-SEP", { quantity: 5, expiryDate: "2026-09-30", receivedDate: "2026-03-01" }],
      ],
    })
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([
        movement({
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-03-15",
          quantityDelta: -4,
          batchNumber: undefined,
          expiryDate: undefined,
          allocation: "fefo",
        }),
      ]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    })

    const call = state.calls.at(-1)!
    expect((call.p_allocations as Array<Record<string, unknown>>).map((entry) => [
      entry.batch_number,
      entry.quantity_delta,
    ])).toEqual([
      ["B-JUN", -2],
      ["B-SEP", -2],
    ])
    expect(state.batches.get("product-1|B-JUN")).toMatchObject({ quantity: 0 })
    expect(state.batches.get("product-1|B-SEP")).toMatchObject({ quantity: 3 })
  })

  it("writes every batch allocation of one voucher line", async () => {
    // Two allocations on one line share (source_id, line_index); the second is
    // a movement of its own and must not read as already applied.
    const { db, state } = replayDb()
    await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: replayPlan([
        movement({
          movementId: "company-guid:voucher-2:L0:B0",
          lineIndex: 0,
          batchIndex: 0,
          batchNumber: "B-1",
          quantityDelta: 4,
          amount: 40,
        }),
        movement({
          movementId: "company-guid:voucher-2:L0:B1",
          lineIndex: 0,
          batchIndex: 1,
          batchNumber: "B-2",
          quantityDelta: 2,
          amount: 20,
        }),
      ]),
      progress: stockHistoryProgress(),
      movementTotalChunks: 1,
      replayTarget: replayTarget(),
    })

    expect(state.products.get("product-1")).toBe(6)
    expect(state.batches.get("product-1|B-1")).toMatchObject({ quantity: 4 })
    expect(state.batches.get("product-1|B-2")).toMatchObject({ quantity: 2 })
  })

  it("refuses to close when the ledger is short, as a closed period leaves it", async () => {
    const { db, state } = replayDb()
    const target = replayTarget({
      simulated: {
        accounts: { "4000": -250 },
        items: [],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 1,
      },
    })

    await expect(
      applyTallyChunk(db, {
        tenantId: "tenant-1",
        actorId: "user-1",
        sessionId: "session-1",
        replay: true,
        plan: plan(),
        progress: { ...emptyProgress(), stage: "replay-closing" },
        replayTarget: target,
      }),
    ).rejects.toThrow(/TALLY_REPLAY_CLOSING_MISMATCH.*4000/)
    expect(state.audits).toHaveLength(0)
  })

  it("completes once the stock and ledger match the reviewed position", async () => {
    const { db, state } = replayDb({
      quantity: 5,
      batches: [["product-1|B-1", { quantity: 5, expiryDate: "2026-12-31", receivedDate: "2026-04-02" }]],
      accounts: [{ code: "4000", debit: 0, credit: 250 }],
    })
    const target = replayTarget({
      simulated: {
        accounts: { "4000": -250 },
        items: [{ stockItemName: "Test Item A", quantity: 5, value: 50, batches: [] }],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 1,
      },
    })

    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-1",
      replay: true,
      plan: plan({ stockItems: [stockItem()] }),
      progress: { ...emptyProgress(), stage: "replay-closing" },
      replayTarget: target,
    })

    expect(result.done).toBe(true)
    expect(result.progress.stage).toBe("complete")
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({
      action: "IMPORT_TALLY_REPLAY",
      entity: "IMPORT_SESSION",
      entity_id: "session-1",
    })
  })

  it("records the closing checkpoint once, however often the stage is retried", async () => {
    const { db, state } = replayDb({
      quantity: 5,
      batches: [["product-1|B-1", { quantity: 5, expiryDate: "2026-12-31", receivedDate: "2026-04-02" }]],
      accounts: [{ code: "4000", debit: 0, credit: 250 }],
    })
    const target = replayTarget({
      simulated: {
        accounts: { "4000": -250 },
        items: [{ stockItemName: "Test Item A", quantity: 5, value: 50, batches: [] }],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 1,
      },
    })
    // A crash before the checkpoint advanced retries the same stage, which is
    // what a resumed apply request does.
    const retry = () =>
      applyTallyChunk(db, {
        tenantId: "tenant-1",
        actorId: "user-1",
        sessionId: "session-1",
        replay: true,
        plan: plan({ stockItems: [stockItem()] }),
        progress: { ...emptyProgress(), stage: "replay-closing" },
        replayTarget: target,
      })

    await retry()
    await retry()

    expect(state.checkpointCalls).toHaveLength(2)
    expect(state.checkpoints.size).toBe(1)
    expect([...state.checkpoints.keys()]).toEqual(["company-guid|2026-09-30"])
    expect(state.checkpoints.get("company-guid|2026-09-30")).toMatchObject({
      through_date: "2026-09-30",
      company_key: "company-guid",
    })
  })

  it("does not close when the checkpoint cannot be recorded", async () => {
    const { db } = replayDb({
      quantity: 5,
      batches: [["product-1|B-1", { quantity: 5, expiryDate: "2026-12-31", receivedDate: "2026-04-02" }]],
      accounts: [{ code: "4000", debit: 0, credit: 250 }],
      checkpointError: "TALLY_CHECKPOINT_TAKEN: another session already closed this period",
    })
    const target = replayTarget({
      simulated: {
        accounts: { "4000": -250 },
        items: [{ stockItemName: "Test Item A", quantity: 5, value: 50, batches: [] }],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 1,
      },
    })

    await expect(
      applyTallyChunk(db, {
        tenantId: "tenant-1",
        actorId: "user-1",
        sessionId: "session-1",
        replay: true,
        plan: plan({ stockItems: [stockItem()] }),
        progress: { ...emptyProgress(), stage: "replay-closing" },
        replayTarget: target,
      }),
    ).rejects.toThrow(/TALLY_CHECKPOINT_FAILED.*another session already closed/)
  })
})

describe("continuation opening stages", () => {
  function checkpoint(overrides: Partial<TallyReplayCheckpoint> = {}): TallyReplayCheckpoint {
    return {
      id: "checkpoint-1",
      companyKey: "company-guid",
      sessionId: "session-0",
      previousId: null,
      throughDate: "2026-03-31",
      closingState: {
        accounts: {},
        items: [],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 0,
      },
      createdAt: "2026-04-01T00:00:00.000Z",
      ...overrides,
    }
  }

  it("verifies the ledger instead of posting the opening journal again", async () => {
    const { db, operations } = replayDb({ accounts: [{ code: "4000", debit: 0, credit: 250 }] })

    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-2",
      replay: true,
      plan: plan(),
      progress: { ...emptyProgress(), stage: "opening-journal" },
      continuation: checkpoint({ closingState: {
        accounts: { "4000": -250 },
        items: [],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 1,
      } }),
    })

    expect(result.progress.stage).toBe("opening-stock")
    expect(operations.some((entry) => entry.table === "rpc:post_pharmacy_accounting_journal")).toBe(false)
  })

  it("verifies stock instead of replaying the opening batches", async () => {
    const { db, operations } = replayDb({
      quantity: 5,
      batches: [["product-1|B-1", { quantity: 5, expiryDate: "2026-12-31", receivedDate: "2026-04-02" }]],
    })

    const result = await applyTallyChunk(db, {
      tenantId: "tenant-1",
      actorId: "user-1",
      sessionId: "session-2",
      replay: true,
      plan: plan({ stockItems: [stockItem()] }),
      progress: { ...emptyProgress(), stage: "opening-stock" },
      continuation: checkpoint({ closingState: {
        accounts: {},
        items: [{ stockItemName: "Test Item A", quantity: 5, value: 50, batches: [] }],
        sourceIdsByItem: {},
        sourceIdsByAccount: {},
        eventCount: 1,
      } }),
    })

    expect(result.progress.stage).toBe("stock-history")
    expect(result.progress.offset).toBe(0)
    expect(operations.some((entry) => entry.table === "rpc:apply_pharmacy_tally_replay_movement")).toBe(false)
  })

  it("refuses to continue when the ledger no longer matches the checkpoint", async () => {
    const { db } = replayDb({ accounts: [{ code: "4000", debit: 0, credit: 300 }] })

    await expect(
      applyTallyChunk(db, {
        tenantId: "tenant-1",
        actorId: "user-1",
        sessionId: "session-2",
        replay: true,
        plan: plan(),
        progress: { ...emptyProgress(), stage: "opening-journal" },
        continuation: checkpoint({ closingState: {
          accounts: { "4000": -250 },
          items: [],
          sourceIdsByItem: {},
          sourceIdsByAccount: {},
          eventCount: 1,
        } }),
      }),
    ).rejects.toThrow(/TALLY_CONTINUATION_DRIFT.*4000/)
  })

  it("refuses to continue when stock no longer matches the checkpoint", async () => {
    const { db } = replayDb({ quantity: 4 })

    await expect(
      applyTallyChunk(db, {
        tenantId: "tenant-1",
        actorId: "user-1",
        sessionId: "session-2",
        replay: true,
        plan: plan({ stockItems: [stockItem()] }),
        progress: { ...emptyProgress(), stage: "opening-stock" },
        continuation: checkpoint({ closingState: {
          accounts: {},
          items: [{ stockItemName: "Test Item A", quantity: 5, value: 50, batches: [] }],
          sourceIdsByItem: {},
          sourceIdsByAccount: {},
          eventCount: 1,
        } }),
      }),
    ).rejects.toThrow(/TALLY_CONTINUATION_DRIFT.*Test Item A/)
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
