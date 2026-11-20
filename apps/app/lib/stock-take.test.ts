import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildEntry,
  countProgress,
  countedTotal,
  filterItems,
  findByScan,
  nextUploadBatch,
  parseCountInput,
  parseExpiryInput,
  searchItems,
  syncStatesFromResults,
  validateCountEntry,
  type LocalCountEntry,
  type StockTakeItem,
} from "./stock-take.ts"
import {
  previewStockTakePosting,
  shouldReplaceCount,
  type ReviewCount,
  type ReviewOverride,
} from "../../../packages/db/src/stock-take.ts"

const items: StockTakeItem[] = [
  { id: "p1", name: "Amoxicillin 500mg caps", sku: "AMX500", barcode: "6001234567890", category: "Antibiotics", unit: "Capsule", bookQty: -5, negativeBook: true, batches: [] },
  { id: "p2", name: "Paracetamol 500mg tabs", sku: "PARA", barcode: "012345678905", category: "Analgesics", unit: "Tablet", bookQty: 30, negativeBook: false, batches: [] },
  { id: "p3", name: "Para-cough syrup", sku: "PCS", barcode: null, category: "Cough", unit: "Bottle", bookQty: 4, negativeBook: false, batches: [] },
]

function entry(overrides: Partial<LocalCountEntry>): LocalCountEntry {
  return {
    entryId: "e1", stockTakeId: "t1", productId: "p1", batchKey: "unbatched", batchId: null,
    newBatchNumber: null, newExpiryDate: null, countedQty: 1, countedAt: "2026-11-18T09:00:00.000Z",
    syncState: "pending", lastError: null, ...overrides,
  }
}

describe("finding items", () => {
  it("matches a scan exactly on barcode or SKU, never by substring", () => {
    assert.deepEqual(findByScan(items, "6001234567890").map((i) => i.id), ["p1"])
    assert.deepEqual(findByScan(items, " amx500 ").map((i) => i.id), ["p1"])
    assert.deepEqual(findByScan(items, "600123"), [])
  })

  it("treats a UPC-A scan and its EAN-13 form as the same code", () => {
    assert.deepEqual(findByScan(items, "0012345678905").map((i) => i.id), ["p2"])
    assert.deepEqual(findByScan(items, "12345678905").map((i) => i.id), ["p2"])
  })

  it("ranks name prefix above word matches in search", () => {
    assert.deepEqual(searchItems(items, "para").map((i) => i.id), ["p2", "p3"])
    const hits = searchItems(items, "500 caps").map((i) => i.id)
    assert.deepEqual(hits, ["p1"])
    assert.equal(searchItems(items, "PARA")[0].id, "p2")
  })
})

describe("reading what was typed", () => {
  it("adds up boxes and loose units", () => {
    assert.equal(parseCountInput("12"), 12)
    assert.equal(parseCountInput("3x20+5"), 65)
    assert.equal(parseCountInput("2 × 10 + 3 * 4"), 32)
    assert.equal(parseCountInput("0"), 0)
    assert.equal(parseCountInput(""), null)
    assert.ok(Number.isNaN(parseCountInput("-3")))
    assert.ok(Number.isNaN(parseCountInput("1.5")))
    assert.ok(Number.isNaN(parseCountInput("3x")))
  })

  it("reads pack expiry formats as dates", () => {
    assert.equal(parseExpiryInput("03/28"), "2028-03-31")
    assert.equal(parseExpiryInput("2/2028"), "2028-02-29")
    assert.equal(parseExpiryInput("2027-02"), "2027-02-28")
    assert.equal(parseExpiryInput("15/03/2028"), "2028-03-15")
    assert.equal(parseExpiryInput("2028-03-15"), "2028-03-15")
    assert.equal(parseExpiryInput("13/28"), null)
    assert.equal(parseExpiryInput("31/02/2028"), null)
    assert.equal(parseExpiryInput("soon"), null)
  })
})

describe("progress and filters", () => {
  const entries = [
    entry({ productId: "p1", countedQty: 4, batchKey: "unbatched" }),
    entry({ entryId: "e2", productId: "p1", countedQty: 6, batchKey: "new:LOT1" }),
    entry({ entryId: "e3", productId: "p2", countedQty: null, syncState: "synced" }),
    entry({ entryId: "e4", productId: "p3", countedQty: 0, syncState: "rejected" }),
  ]

  it("sums a product's lines and ignores cleared ones", () => {
    assert.equal(countedTotal(entries, "p1"), 10)
    assert.equal(countedTotal(entries, "p2"), null)
    assert.equal(countedTotal(entries, "p3"), 0)
  })

  it("counts a zero as counted", () => {
    const progress = countProgress(items, entries)
    assert.deepEqual(progress, { total: 3, counted: 2, pending: 2, rejected: 1, percent: 67 })
  })

  it("filters to do, done and uncounted negatives", () => {
    assert.deepEqual(filterItems(items, entries, "todo").map((i) => i.id), ["p2"])
    assert.deepEqual(filterItems(items, entries, "done").map((i) => i.id), ["p1", "p3"])
    assert.deepEqual(filterItems(items, [], "negative").map((i) => i.id), ["p1"])
    assert.deepEqual(filterItems(items, entries, "negative"), [])
  })
})

describe("entries and upload", () => {
  it("keys a counted batch by id, a found batch by number, otherwise unbatched", () => {
    const ids = ["a", "b", "c"]
    const make = (p: Partial<Parameters<typeof buildEntry>[0]>) =>
      buildEntry({ stockTakeId: "t1", productId: "p1", countedQty: 2, newId: () => ids.shift()!, now: new Date("2026-11-18T10:00:00Z"), ...p })
    assert.equal(make({ batchId: "5f0b8c1e-0000-4000-8000-000000000001" }).batchKey, "5f0b8c1e-0000-4000-8000-000000000001")
    const found = make({ newBatchNumber: " lot  9 ", newExpiryDate: "2028-01-31" })
    assert.equal(found.batchKey, "new:LOT 9")
    assert.equal(found.newBatchNumber, "LOT 9")
    assert.equal(make({}).batchKey, "unbatched")
  })

  it("validates what the server would reject before it is queued", () => {
    const base = { entryId: "5f0b8c1e-0000-4000-8000-000000000001", productId: "5f0b8c1e-0000-4000-8000-000000000002", countedAt: "2026-11-18T10:00:00Z" }
    assert.equal(validateCountEntry({ ...base, countedQty: 3 }), null)
    assert.equal(validateCountEntry({ ...base, countedQty: null }), null)
    assert.match(validateCountEntry({ ...base, countedQty: -1 }) ?? "", /below zero/)
    assert.match(validateCountEntry({ ...base, countedQty: 2.5 }) ?? "", /whole number/)
    assert.match(validateCountEntry({ ...base, countedQty: 2, newBatchNumber: "L1" }) ?? "", /expiry/)
    assert.match(validateCountEntry({ ...base, countedQty: 2, newBatchNumber: "neg-stock", newExpiryDate: "2028-01-01" }) ?? "", /NEG-STOCK/)
  })

  it("uploads only pending entries, oldest first, in bounded batches", () => {
    const list = [
      entry({ entryId: "late", countedAt: "2026-11-18T11:00:00Z" }),
      entry({ entryId: "done", syncState: "synced" }),
      entry({ entryId: "early", countedAt: "2026-11-18T08:00:00Z" }),
      entry({ entryId: "held", syncState: "closed" }),
    ]
    assert.deepEqual(nextUploadBatch(list).map((e) => e.entryId), ["early", "late"])
    assert.deepEqual(nextUploadBatch(list, 1).map((e) => e.entryId), ["early"])
  })

  it("settles saved, cleared and stale entries; keeps rejected ones with the reason", () => {
    const states = syncStatesFromResults([
      { entryId: "a", outcome: "saved" },
      { entryId: "b", outcome: "stale" },
      { entryId: "c", outcome: "cleared" },
      { entryId: "d", outcome: "rejected", reason: "Product not found" },
    ])
    assert.equal(states.get("a")?.syncState, "synced")
    assert.equal(states.get("b")?.syncState, "synced")
    assert.equal(states.get("c")?.syncState, "synced")
    assert.deepEqual(states.get("d"), { syncState: "rejected", lastError: "Product not found" })
  })

  it("lets the newest count from the same person win", () => {
    assert.equal(shouldReplaceCount(null, { countedAt: "2026-11-18T09:00:00Z", entryId: "a" }), true)
    assert.equal(shouldReplaceCount({ countedAt: "2026-11-18T10:00:00Z", entryId: "a" }, { countedAt: "2026-11-18T09:00:00Z", entryId: "b" }), false)
    assert.equal(shouldReplaceCount({ countedAt: "2026-11-18T09:00:00Z", entryId: "a" }, { countedAt: "2026-11-18T10:00:00Z", entryId: "b" }), true)
    assert.equal(shouldReplaceCount({ countedAt: "2026-11-18T09:00:00Z", entryId: "a" }, { countedAt: "2026-11-18T09:00:00Z", entryId: "a" }), false)
  })
})

/**
 * The same fixture scripts/db-tests/pharmacy-stock-take.isolated.sh posts
 * against PostgreSQL. The preview the manager reviews must show the numbers
 * post_pharmacy_stock_take then writes.
 */
describe("review preview matches the posting function", () => {
  const product = (id: string, quantity: number, costPrice: number) => ({ id, name: id, sku: null, category: "General", quantity, costPrice })
  const batch = (id: string, productId: string, batchNumber: string, quantity: number, expiryDate: string, costPrice: number) => ({ id, productId, batchNumber, quantity, expiryDate, status: "active", costPrice })
  const count = (productId: string, batchKey: string, countedQty: number, countedBy = "u1", extra: Partial<ReviewCount> = {}): ReviewCount => ({ productId, batchKey, countedQty, countedBy, countedAt: "2026-11-18T09:00:00Z", ...extra })
  const B1 = "00000000-0000-0000-0000-0000000002b1"
  const E1 = "00000000-0000-0000-0000-0000000005e1"
  const D1 = "00000000-0000-0000-0000-0000000004d1"
  const C1 = "00000000-0000-0000-0000-0000000003c1"

  const products = [product("P1", -5, 100), product("P2", 30, 50), product("P3", 12, 10), product("P4", 5, 20), product("P5", 4, 30), product("P6", -2, 30)]
  const batches = [
    batch("00000000-0000-0000-0000-0000000001a1", "P1", "NEG-STOCK", -5, "2099-12-31", 100),
    batch(B1, "P2", "B1", 10, "2027-06-30", 50),
    batch("00000000-0000-0000-0000-0000000002b2", "P2", "B2", 20, "2028-06-30", 60),
    batch(C1, "P3", "C1", 12, "2028-01-31", 10),
    batch(D1, "P4", "D1", 3, "2028-01-31", 20),
    batch(E1, "P5", "E1", 4, "2028-01-31", 30),
    batch("00000000-0000-0000-0000-0000000006f1", "P6", "NEG-STOCK", -2, "2099-12-31", 30),
  ]
  const counts = new Map<string, ReviewCount[]>([
    ["P1", [count("P1", "unbatched", 10)]],
    ["P2", [count("P2", B1, 8), count("P2", B1, 2, "u2"), count("P2", "unbatched", 15)]],
    ["P3", [count("P3", C1, 12)]],
    ["P4", [count("P4", D1, 3)]],
    ["P5", [count("P5", E1, 4), count("P5", "new:NEWB1", 7, "u1", { newBatchNumber: "NEWB1", newExpiryDate: "2028-03-31" })]],
  ])
  const overrides = new Map<string, ReviewOverride[]>([["P5", [{ productId: "P5", batchKey: E1, overrideQty: 6, reason: "Recounted" }]]])
  const review = previewStockTakePosting({ products, batches, countsByProduct: counts, overridesByProduct: overrides, today: "2026-11-18" })
  const line = (id: string) => review.lines.find((l) => l.productId === id)!

  it("lands on the same product totals", () => {
    assert.deepEqual(
      ["P1", "P2", "P3", "P4", "P5", "P6"].map((id) => line(id).finalQty),
      [10, 25, 12, 3, 13, -2],
    )
    assert.equal(line("P2").batches.find((b) => b.batchNumber === "B2")?.finalQty, 15)
    assert.equal(line("P1").batches.find((b) => b.batchNumber === "NEG-STOCK")?.rule, "negative_cleared")
    assert.equal(line("P6").counted, false)
  })

  it("lands on the same totals the database summary reports", () => {
    assert.equal(review.totals.productsCounted, 5)
    assert.equal(review.totals.negativesToClear, 1)
    assert.equal(review.totals.uncountedNegative, 1)
    assert.equal(review.totals.unitsGained, 24)
    assert.equal(review.totals.unitsLost, 7)
    assert.equal(review.totals.valueGained, 1770)
    assert.equal(review.totals.valueLost, 340)
    assert.equal(review.totals.netValue, 1430)
  })

  it("puts uncounted negatives first", () => {
    assert.equal(review.lines[0].productId, "P6")
  })
})
