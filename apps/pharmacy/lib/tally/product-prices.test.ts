/**
 * Product prices written by the Tally import.
 *
 * A new product sells at the price Tally holds (standard price or latest sale)
 * and costs what Tally last paid. An item with no selling price anywhere sells
 * at cost, never at zero: the till accepts a zero price and would give it away.
 * An existing product's price is only filled while it is still a placeholder,
 * so a price set by hand in the portal survives a re-import.
 */
import { describe, expect, it } from "vitest"
import type { TallyCutoverPlan } from "@synapse/db/tally-normalise"
import { applyTallyChunk, emptyProgress, productPrices } from "./apply"
import type { TallyApplyDb } from "./types"

type StockItem = TallyCutoverPlan["stockItems"][number]

function stockItem(overrides: Partial<StockItem> = {}): StockItem {
  return {
    sourceName: "Test Item A",
    sku: "TALLY-A",
    name: "Test Item A",
    unit: "Strip",
    quantity: 12,
    rate: 500,
    value: 6000,
    batches: [],
    ...overrides,
  }
}

describe("productPrices", () => {
  it("sells at Tally's price and costs at its latest purchase", () => {
    expect(
      productPrices(
        stockItem({
          sellingPrice: { amount: 700, source: "last-sale", date: "2026-01-15" },
          purchaseCost: { amount: 540, source: "last-purchase", date: "2026-02-20" },
        }),
      ),
    ).toEqual({ price: 700, cost: 540, priceFromCost: false })
  })

  it("falls back to the opening rate for cost", () => {
    expect(productPrices(stockItem({ sellingPrice: { amount: 700, source: "last-sale" } }))).toEqual({
      price: 700,
      cost: 500,
      priceFromCost: false,
    })
  })

  it("sells an item with no known price at cost, never at zero", () => {
    expect(productPrices(stockItem())).toEqual({ price: 500, cost: 500, priceFromCost: true })
  })
})

/** A products table the products stage reads, inserts into and updates. */
function productsDb(existing: Array<{ id: string; name: string; sku: string; price: number; cost_price: number }>) {
  const rows = existing.map((row) => ({ ...row, tenant_id: "tenant-1" }))
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<{ id: unknown; values: Record<string, unknown> }> = []

  const from = (table: string) => {
    const filters: Array<[string, unknown]> = []
    let action: "select" | "insert" | "update" = "select"
    let payload: Record<string, unknown> | Array<Record<string, unknown>> = {}
    let window: [number, number] | null = null
    const run = () => {
      if (table !== "pharmacy_products") return { data: [], error: null }
      if (action === "insert") {
        // Like PostgREST: an array inserts every row and returns them all.
        const values = Array.isArray(payload) ? payload : [payload]
        const created = values.map((value) => {
          const row = { id: `new-${inserts.length + 1}`, ...value }
          inserts.push(row)
          return row
        })
        return { data: Array.isArray(payload) ? created : created[0], error: null }
      }
      const match = rows.filter((row) => filters.every(([column, value]) => (row as any)[column] === value))
      if (action === "update") {
        updates.push({ id: filters.find(([column]) => column === "id")?.[1], values: payload })
        for (const row of match) Object.assign(row, payload)
        return { data: null, error: null }
      }
      return { data: window ? match.slice(window[0], window[1] + 1) : match, error: null }
    }
    const chain: any = {
      select: () => chain,
      insert: (values: Record<string, unknown> | Array<Record<string, unknown>>) => ((action = "insert"), (payload = values), chain),
      update: (values: Record<string, unknown>) => ((action = "update"), (payload = values), chain),
      eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      range: (start: number, end: number) => ((window = [start, end]), chain),
      single: () => Promise.resolve(run()),
      maybeSingle: () => {
        const result = run()
        return Promise.resolve({ ...result, data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data })
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    }
    return chain
  }

  return { db: { from, rpc: async () => ({ data: null, error: null }) } as unknown as TallyApplyDb, inserts, updates, rows }
}

async function runProducts(db: TallyApplyDb, items: StockItem[]) {
  return applyTallyChunk(db, {
    tenantId: "tenant-1",
    actorId: "user-1",
    sessionId: "session-1",
    plan: { stockItems: items } as unknown as TallyCutoverPlan,
    progress: { ...emptyProgress(), stage: "products" },
  })
}

describe("products stage prices", () => {
  it("creates a product at Tally's selling price, not at its cost", async () => {
    const fake = productsDb([])
    await runProducts(fake.db, [stockItem({ sellingPrice: { amount: 700, source: "last-sale" } })])
    expect(fake.inserts[0]).toMatchObject({ price: 700, cost_price: 500 })
  })

  it("replaces an earlier import's cost-copy price with the real one", async () => {
    const fake = productsDb([{ id: "p1", name: "Test Item A", sku: "OLD", price: 500, cost_price: 500 }])
    await runProducts(fake.db, [stockItem({ sellingPrice: { amount: 700, source: "last-sale" } })])
    expect(fake.updates).toEqual([{ id: "p1", values: { price: 700 } }])
  })

  it("never overwrites a price set by hand", async () => {
    const fake = productsDb([{ id: "p1", name: "Test Item A", sku: "OLD", price: 950, cost_price: 500 }])
    await runProducts(fake.db, [stockItem({ sellingPrice: { amount: 700, source: "last-sale" } })])
    expect(fake.updates).toEqual([])
  })

  it("fills an empty price and cost from cost when Tally has no selling price", async () => {
    const fake = productsDb([{ id: "p1", name: "Test Item A", sku: "OLD", price: 0, cost_price: 0 }])
    await runProducts(fake.db, [stockItem()])
    expect(fake.updates).toEqual([{ id: "p1", values: { price: 500, cost_price: 500 } }])
  })
})
