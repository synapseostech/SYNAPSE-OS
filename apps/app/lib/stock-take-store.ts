import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as SQLite from 'expo-sqlite'
import { ApiError } from './api'
import type { SyncSQLiteConnection } from './offline-store-core'
import { buildEntry, nextUploadBatch, toUploadEntry, type LocalCountEntry } from './stock-take'
import { StockTakeStore, type CachedSheet } from './stock-take-store-core'
import { fetchStockTakeItems, uploadStockTakeCounts } from './stock-take-api'

// Its own file: counts must never sit behind, or block, the sales outbox.
const DATABASE_NAME = 'synapse-stocktake-v1.db'
// Shared with offline-store.ts so the server sees one device id per phone.
const DEVICE_ID_KEY = 'synapse_sync_device_id_v1'

let storePromise: Promise<StockTakeStore> | null = null
const activeFlushes = new Map<string, Promise<FlushSummary>>()

function getStore(): Promise<StockTakeStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const database = await SQLite.openDatabaseAsync(DATABASE_NAME)
      const store = new StockTakeStore(database as unknown as SyncSQLiteConnection)
      await store.initialize()
      return store
    })()
  }
  return storePromise
}

async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY)
  if (existing) return existing
  const created = Crypto.randomUUID()
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created)
  return created
}

export type Scope = { tenantId: string; userId: string }

/** Download the count sheet and keep it; fall back to the kept copy offline. */
export async function loadCountSheet(
  token: string,
  scope: Scope,
  stockTakeId: string,
  options: { refresh?: boolean } = {},
): Promise<{ sheet: CachedSheet | null; offline: boolean; error?: string }> {
  const store = await getStore()
  const cached = await store.loadSheet(scope.tenantId, stockTakeId)
  if (cached && !options.refresh) return { sheet: cached, offline: false }
  try {
    const fresh = await fetchStockTakeItems(token, stockTakeId)
    const sheet: CachedSheet = { stockTake: fresh.stockTake, items: fresh.items, capturedAt: fresh.capturedAt }
    await store.saveSheet(scope.tenantId, sheet)
    if (fresh.stockTake.status === 'counting') {
      await store.reopenClosed(scope.tenantId, scope.userId, stockTakeId)
    }
    return { sheet, offline: false }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await store.forgetTake(scope.tenantId, stockTakeId)
      return { sheet: null, offline: false, error: error.message }
    }
    return {
      sheet: cached,
      offline: true,
      error: error instanceof Error ? error.message : 'Could not download the count sheet',
    }
  }
}

export async function latestCountSheet(scope: Scope): Promise<CachedSheet | null> {
  return (await getStore()).latestSheet(scope.tenantId)
}

export async function listCountEntries(scope: Scope, stockTakeId: string): Promise<LocalCountEntry[]> {
  return (await getStore()).listEntries(scope.tenantId, scope.userId, stockTakeId)
}

/** Save one counted line on the phone first; sending happens after. */
export async function saveCount(
  scope: Scope,
  params: Omit<Parameters<typeof buildEntry>[0], 'newId'>,
): Promise<LocalCountEntry> {
  const entry = buildEntry({ ...params, newId: () => Crypto.randomUUID() })
  await (await getStore()).putEntry(scope.tenantId, scope.userId, entry)
  return entry
}

export type FlushSummary = { sent: number; rejected: number; closed: boolean; error?: string }

/** Send pending counts in batches. Safe to call often; one run per take at a time. */
export function flushCounts(token: string, scope: Scope, stockTakeId: string): Promise<FlushSummary> {
  const key = `${scope.tenantId}|${scope.userId}|${stockTakeId}`
  const active = activeFlushes.get(key)
  if (active) return active
  const run = (async (): Promise<FlushSummary> => {
    const store = await getStore()
    const device = await deviceId()
    let sent = 0
    let rejected = 0
    for (let round = 0; round < 50; round++) {
      const entries = await store.listEntries(scope.tenantId, scope.userId, stockTakeId)
      const batch = nextUploadBatch(entries)
      if (batch.length === 0) break
      try {
        const response = await uploadStockTakeCounts(token, stockTakeId, device, batch.map(toUploadEntry))
        await store.applyResults(scope.tenantId, scope.userId, response.results)
        sent += response.results.filter((r) => r.outcome !== 'rejected').length
        rejected += response.results.filter((r) => r.outcome === 'rejected').length
        // An entry the server did not answer for would loop forever.
        const answered = new Set(response.results.map((r) => r.entryId))
        if (batch.every((e) => !answered.has(e.entryId))) break
      } catch (error) {
        if (error instanceof ApiError && error.payload.code === 'STOCK_TAKE_CLOSED') {
          await store.markClosed(scope.tenantId, scope.userId, stockTakeId, error.message)
          return { sent, rejected, closed: true, error: error.message }
        }
        return { sent, rejected, closed: false, error: error instanceof Error ? error.message : 'Upload failed' }
      }
    }
    return { sent, rejected, closed: false }
  })().finally(() => activeFlushes.delete(key))
  activeFlushes.set(key, run)
  return run
}
