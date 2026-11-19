import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DatabaseSync } from "node:sqlite"
import type { SyncSQLiteConnection, SQLiteValue } from "./offline-store-core.ts"
import { StockTakeStore } from "./stock-take-store-core.ts"
import { buildEntry, type StockTakeView } from "./stock-take.ts"

/** node:sqlite behind the async interface expo-sqlite gives the app. */
function connection(): SyncSQLiteConnection {
  const db = new DatabaseSync(":memory:")
  const conn: SyncSQLiteConnection = {
    async execAsync(source: string) {
      db.exec(source)
    },
    async runAsync(source: string, params: SQLiteValue[]) {
      return db.prepare(source).run(...(params as never[]))
    },
    async getFirstAsync<T>(source: string, params: SQLiteValue[] = []) {
      return (db.prepare(source).get(...(params as never[])) as T | undefined) ?? null
    },
    async getAllAsync<T>(source: string, params: SQLiteValue[] = []) {
      return db.prepare(source).all(...(params as never[])) as T[]
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec("BEGIN")
      try {
        await task()
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  }
  return conn
}

const T = "tenant-a"
const U = "user-1"
const take: StockTakeView = {
  id: "take-1", reference: "ST-20261118-01", title: "Full", scope: "all", categories: [], blind: true,
  status: "counting", notes: null, openedAt: "2026-11-18T08:00:00Z", closedAt: null, postedAt: null,
  postingSummary: null, showBook: false, canManage: false,
}
let n = 0
const newId = () => `id-${++n}`

describe("offline stock-take store", () => {
  it("keeps the count sheet for offline use", async () => {
    const store = new StockTakeStore(connection())
    await store.saveSheet(T, { stockTake: take, items: [{ id: "p1", name: "A", sku: null, barcode: null, category: null, unit: null, batches: [] }], capturedAt: "2026-11-18T08:05:00Z" })
    const sheet = await store.loadSheet(T, "take-1")
    assert.equal(sheet?.items.length, 1)
    assert.equal((await store.latestSheet(T))?.stockTake.reference, "ST-20261118-01")
    assert.equal(await store.loadSheet("tenant-b", "take-1"), null)
  })

  it("holds one latest value per product and batch, pending until sent", async () => {
    const store = new StockTakeStore(connection())
    await store.putEntry(T, U, buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 4, newId }))
    await store.putEntry(T, U, buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 6, newId }))
    await store.putEntry(T, U, buildEntry({ stockTakeId: "take-1", productId: "p1", newBatchNumber: "L1", newExpiryDate: "2028-01-31", countedQty: 2, newId }))
    const entries = await store.listEntries(T, U, "take-1")
    assert.equal(entries.length, 2)
    assert.equal(entries.find((e) => e.batchKey === "unbatched")?.countedQty, 6)
    assert.ok(entries.every((e) => e.syncState === "pending"))
    // Another person on the same phone keeps their own lines.
    await store.putEntry(T, "user-2", buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 1, newId }))
    assert.equal((await store.listEntries(T, U, "take-1")).length, 2)
  })

  it("settles uploaded entries but not one edited while the upload was in flight", async () => {
    const store = new StockTakeStore(connection())
    const sent = buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 4, newId })
    const other = buildEntry({ stockTakeId: "take-1", productId: "p2", countedQty: 1, newId })
    await store.putEntry(T, U, sent)
    await store.putEntry(T, U, other)
    // The counter corrects p1 before the server answers.
    await store.putEntry(T, U, buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 5, newId }))
    await store.applyResults(T, U, [
      { entryId: sent.entryId, outcome: "saved" },
      { entryId: other.entryId, outcome: "rejected", reason: "Product not found" },
    ])
    const entries = await store.listEntries(T, U, "take-1")
    const p1 = entries.find((e) => e.productId === "p1")!
    const p2 = entries.find((e) => e.productId === "p2")!
    assert.equal(p1.countedQty, 5)
    assert.equal(p1.syncState, "pending")
    assert.equal(p2.syncState, "rejected")
    assert.equal(p2.lastError, "Product not found")
  })

  it("holds counts when counting closes and retries them when it reopens", async () => {
    const store = new StockTakeStore(connection())
    await store.putEntry(T, U, buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 4, newId }))
    await store.markClosed(T, U, "take-1", "Counting has closed")
    let [entry] = await store.listEntries(T, U, "take-1")
    assert.equal(entry.syncState, "closed")
    assert.equal(entry.countedQty, 4)
    await store.reopenClosed(T, U, "take-1")
    ;[entry] = await store.listEntries(T, U, "take-1")
    assert.equal(entry.syncState, "pending")
  })

  it("forgets a take that no longer exists", async () => {
    const store = new StockTakeStore(connection())
    await store.saveSheet(T, { stockTake: take, items: [], capturedAt: "2026-11-18T08:05:00Z" })
    await store.putEntry(T, U, buildEntry({ stockTakeId: "take-1", productId: "p1", countedQty: 4, newId }))
    await store.forgetTake(T, "take-1")
    assert.equal(await store.loadSheet(T, "take-1"), null)
    assert.deepEqual(await store.listEntries(T, U, "take-1"), [])
  })
})
