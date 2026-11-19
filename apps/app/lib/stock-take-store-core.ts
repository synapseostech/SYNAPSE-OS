/**
 * Offline stock-take store. Same SQLite contract as the sales outbox
 * (offline-store-core.ts) so Expo and node:test share one implementation, but
 * its own tables: a count is a value that keeps changing until it is sent, not
 * a command to apply once, so one row per counter, product and batch holds the
 * latest value and its sync state.
 */
import type { SyncSQLiteConnection } from './offline-store-core'
import type {
  EntrySyncState,
  LocalCountEntry,
  StockTakeItem,
  StockTakeView,
  UploadResult,
} from './stock-take'
import { syncStatesFromResults } from './stock-take'

type EntryRow = {
  entry_key: string
  tenant_id: string
  user_id: string
  stock_take_id: string
  product_id: string
  batch_key: string
  entry_json: string
  sync_state: EntrySyncState
  last_error: string | null
  updated_at: string
}

export type CachedSheet = {
  stockTake: StockTakeView
  items: StockTakeItem[]
  capturedAt: string
}

export class StockTakeStore {
  private initialization: Promise<void> | null = null

  constructor(private readonly database: SyncSQLiteConnection) {}

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.database.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS synapse_stocktake_sheet (
          tenant_id TEXT NOT NULL,
          stock_take_id TEXT NOT NULL,
          stock_take_json TEXT NOT NULL,
          items_json TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, stock_take_id)
        );
        CREATE TABLE IF NOT EXISTS synapse_stocktake_entries (
          entry_key TEXT PRIMARY KEY NOT NULL,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          stock_take_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          batch_key TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          sync_state TEXT NOT NULL CHECK (sync_state IN ('pending','synced','rejected','closed')),
          last_error TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS synapse_stocktake_entries_take_idx
          ON synapse_stocktake_entries (tenant_id, user_id, stock_take_id, sync_state);
      `)
    }
    return this.initialization
  }

  async saveSheet(tenantId: string, sheet: CachedSheet): Promise<void> {
    await this.initialize()
    await this.database.runAsync(
      `INSERT INTO synapse_stocktake_sheet (tenant_id, stock_take_id, stock_take_json, items_json, captured_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, stock_take_id) DO UPDATE SET
         stock_take_json = excluded.stock_take_json,
         items_json = excluded.items_json,
         captured_at = excluded.captured_at`,
      [
        tenantId,
        sheet.stockTake.id,
        JSON.stringify(sheet.stockTake),
        JSON.stringify(sheet.items),
        sheet.capturedAt,
      ],
    )
  }

  async loadSheet(tenantId: string, stockTakeId: string): Promise<CachedSheet | null> {
    await this.initialize()
    const row = await this.database.getFirstAsync<{
      stock_take_json: string
      items_json: string
      captured_at: string
    }>(
      `SELECT stock_take_json, items_json, captured_at FROM synapse_stocktake_sheet
       WHERE tenant_id = ? AND stock_take_id = ?`,
      [tenantId, stockTakeId],
    )
    if (!row) return null
    return {
      stockTake: JSON.parse(row.stock_take_json) as StockTakeView,
      items: JSON.parse(row.items_json) as StockTakeItem[],
      capturedAt: row.captured_at,
    }
  }

  /** The most recent sheet on this phone, for opening a count with no signal. */
  async latestSheet(tenantId: string): Promise<CachedSheet | null> {
    await this.initialize()
    const row = await this.database.getFirstAsync<{ stock_take_id: string }>(
      `SELECT stock_take_id FROM synapse_stocktake_sheet WHERE tenant_id = ?
       ORDER BY captured_at DESC LIMIT 1`,
      [tenantId],
    )
    return row ? this.loadSheet(tenantId, row.stock_take_id) : null
  }

  /**
   * Record the counter's latest value for one product and batch. Replaces the
   * previous local value and makes it pending again, whatever it was.
   */
  async putEntry(tenantId: string, userId: string, entry: LocalCountEntry): Promise<void> {
    await this.initialize()
    const key = [tenantId, userId, entry.stockTakeId, entry.productId, entry.batchKey].join('|')
    const stored: LocalCountEntry = { ...entry, syncState: 'pending', lastError: null }
    await this.database.runAsync(
      `INSERT INTO synapse_stocktake_entries (
         entry_key, tenant_id, user_id, stock_take_id, product_id, batch_key,
         entry_id, entry_json, sync_state, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
       ON CONFLICT(entry_key) DO UPDATE SET
         entry_id = excluded.entry_id,
         entry_json = excluded.entry_json,
         sync_state = 'pending',
         last_error = NULL,
         updated_at = excluded.updated_at`,
      [
        key,
        tenantId,
        userId,
        entry.stockTakeId,
        entry.productId,
        entry.batchKey,
        entry.entryId,
        JSON.stringify(stored),
        entry.countedAt,
      ],
    )
  }

  async listEntries(tenantId: string, userId: string, stockTakeId: string): Promise<LocalCountEntry[]> {
    await this.initialize()
    const rows = await this.database.getAllAsync<EntryRow>(
      `SELECT * FROM synapse_stocktake_entries
       WHERE tenant_id = ? AND user_id = ? AND stock_take_id = ?
       ORDER BY updated_at ASC`,
      [tenantId, userId, stockTakeId],
    )
    return rows.map(hydrate)
  }

  /**
   * Apply the server's answer. Only rows still holding the uploaded entry id
   * change: a counter who edited the line while the upload was in flight keeps
   * the new value pending.
   */
  async applyResults(tenantId: string, userId: string, results: UploadResult[]): Promise<void> {
    await this.initialize()
    const states = syncStatesFromResults(results)
    if (states.size === 0) return
    await this.transaction(async (tx) => {
      for (const [entryId, state] of states) {
        const row = await tx.getFirstAsync<EntryRow>(
          `SELECT * FROM synapse_stocktake_entries WHERE tenant_id = ? AND user_id = ? AND entry_id = ?`,
          [tenantId, userId, entryId],
        )
        if (!row) continue
        const entry = { ...hydrate(row), syncState: state.syncState, lastError: state.lastError }
        await tx.runAsync(
          `UPDATE synapse_stocktake_entries
           SET sync_state = ?, last_error = ?, entry_json = ?
           WHERE entry_key = ? AND entry_id = ?`,
          [state.syncState, state.lastError, JSON.stringify(entry), row.entry_key, entryId],
        )
      }
    })
  }

  /** Counting closed on the server: keep the values, stop retrying them. */
  async markClosed(tenantId: string, userId: string, stockTakeId: string, message: string): Promise<void> {
    await this.setStateForTake(tenantId, userId, stockTakeId, 'pending', 'closed', message)
  }

  /** The manager reopened counting: try the held values again. */
  async reopenClosed(tenantId: string, userId: string, stockTakeId: string): Promise<void> {
    await this.setStateForTake(tenantId, userId, stockTakeId, 'closed', 'pending', null)
  }

  async forgetTake(tenantId: string, stockTakeId: string): Promise<void> {
    await this.initialize()
    await this.transaction(async (tx) => {
      await tx.runAsync(`DELETE FROM synapse_stocktake_entries WHERE tenant_id = ? AND stock_take_id = ?`, [
        tenantId,
        stockTakeId,
      ])
      await tx.runAsync(`DELETE FROM synapse_stocktake_sheet WHERE tenant_id = ? AND stock_take_id = ?`, [
        tenantId,
        stockTakeId,
      ])
    })
  }

  private async setStateForTake(
    tenantId: string,
    userId: string,
    stockTakeId: string,
    from: EntrySyncState,
    to: EntrySyncState,
    message: string | null,
  ): Promise<void> {
    await this.initialize()
    await this.transaction(async (tx) => {
      const rows = await tx.getAllAsync<EntryRow>(
        `SELECT * FROM synapse_stocktake_entries
         WHERE tenant_id = ? AND user_id = ? AND stock_take_id = ? AND sync_state = ?`,
        [tenantId, userId, stockTakeId, from],
      )
      for (const row of rows) {
        const entry = { ...hydrate(row), syncState: to, lastError: message }
        await tx.runAsync(
          `UPDATE synapse_stocktake_entries SET sync_state = ?, last_error = ?, entry_json = ? WHERE entry_key = ?`,
          [to, message, JSON.stringify(entry), row.entry_key],
        )
      }
    })
  }

  private async transaction(task: (tx: SyncSQLiteConnection) => Promise<void>): Promise<void> {
    if (this.database.withExclusiveTransactionAsync) {
      await this.database.withExclusiveTransactionAsync(task)
    } else {
      await this.database.withTransactionAsync(() => task(this.database))
    }
  }
}

function hydrate(row: EntryRow): LocalCountEntry {
  const entry = JSON.parse(row.entry_json) as LocalCountEntry
  return { ...entry, syncState: row.sync_state, lastError: row.last_error }
}
