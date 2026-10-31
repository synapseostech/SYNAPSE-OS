import {
  resolveSyncConflict,
  type SyncCommand,
  type SyncConflict,
  type SyncOutboxStatus,
} from '../../../packages/db/src/sync-contract'
import type {
  SyncApplyResult,
  SyncOutboxRecord,
  SyncOutboxStore,
  SyncPersistResult,
} from '../../../packages/db/src/sync-runtime'

export type SQLiteValue = string | number | null | Uint8Array

export interface SyncSQLiteConnection {
  execAsync(source: string): Promise<void>
  runAsync(source: string, params: SQLiteValue[]): Promise<unknown>
  getFirstAsync<T>(source: string, params?: SQLiteValue[]): Promise<T | null>
  getAllAsync<T>(source: string, params?: SQLiteValue[]): Promise<T[]>
  withTransactionAsync(task: () => Promise<void>): Promise<void>
  withExclusiveTransactionAsync?(
    task: (transaction: SyncSQLiteConnection) => Promise<void>,
  ): Promise<void>
}

type OutboxRow = {
  command_id: string
  tenant_id: string
  payload_hash: string
  command_json: string
  status: SyncOutboxStatus
  attempt_count: number
  last_error: string | null
  server_ack_id: string | null
  applied_at: string | null
  checkpoint: string | null
  response_json: string | null
  created_at: string
  updated_at: string
}

export type OfflineSyncStatus = {
  pending: number
  rejected: number
  conflicts: number
}

export type OfflineOutboxListItem = {
  commandId: string
  commandType: string
  status: SyncOutboxStatus
  lastError: string | null
  createdAt: string
  updatedAt: string
  attemptCount: number
}

export type StockSnapshotRow = {
  productId: string
  batchId: string
  quantity: number
  expiryDate: string | null
}

export type CatalogueProduct = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  price: number
  quantity: number
  sellableQuantity?: number
  unit?: string
  requiresPrescription?: boolean
  packages?: Array<{
    id: string
    name: string
    unitsPerPackage: number
    price: number
    isDefault: boolean
  }>
  batches: Array<{
    id: string
    batchNumber: string
    quantity: number
    expiryDate: string
    sellingPrice?: number
  }>
}

export type SaleStockLine = {
  productId: string
  quantity: number
  batchId: string | null
}

export type StockReservation = {
  productId: string
  batchId: string
  quantity: number
}

export const OFFLINE_STOCK_MAX_AGE_MS = 4 * 60 * 60 * 1000

export class OfflineStockError extends Error {
  readonly code: 'INSUFFICIENT_STOCK' | 'OFFLINE_STOCK_STALE' | 'OFFLINE_OPERATION_UNSUPPORTED'
  readonly productId?: string
  readonly requestedQuantity?: number
  readonly sellableQuantity?: number

  constructor(
    code: OfflineStockError['code'],
    message: string,
    extra: {
      productId?: string
      requestedQuantity?: number
      sellableQuantity?: number
    } = {},
  ) {
    super(message)
    this.name = 'OfflineStockError'
    this.code = code
    this.productId = extra.productId
    this.requestedQuantity = extra.requestedQuantity
    this.sellableQuantity = extra.sellableQuantity
  }
}

const READY_STATUSES = "'queued','syncing','applied'"
const HOLD_STATUSES = "'queued','syncing','applied'"
const ACK_RESULT =
  {} as Extract<SyncApplyResult, { outcome: 'applied' | 'replay' }>

export type CommandJsonCodec = {
  encode(json: string): Promise<string>
  decode(stored: string): Promise<string>
}

function rowToRecord(row: OutboxRow, commandJson = row.command_json): SyncOutboxRecord {
  return {
    command: JSON.parse(commandJson) as SyncCommand,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    serverAckId: row.server_ack_id,
    appliedAt: row.applied_at,
    checkpoint: row.checkpoint,
    response: row.response_json ? (JSON.parse(row.response_json) as unknown) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function snapshotKey(productId: string, batchId: string): string {
  return `${productId}::${batchId}`
}

/**
 * Allocate remaining snapshot stock FEFO-first. Specified batch ids are honored;
 * missing batch ids consume earliest-expiry remaining quantity.
 */
export function allocateLocalFefo(
  remaining: Map<string, { productId: string; batchId: string; quantity: number; expiryDate: string | null }>,
  line: SaleStockLine,
): StockReservation[] {
  const requested = Math.trunc(Number(line.quantity))
  if (requested <= 0) {
    throw new OfflineStockError('INSUFFICIENT_STOCK', 'Quantity must be greater than zero.', {
      productId: line.productId,
      requestedQuantity: requested,
      sellableQuantity: 0,
    })
  }

  if (line.batchId) {
    const key = snapshotKey(line.productId, line.batchId)
    const row = remaining.get(key)
    const available = row?.quantity ?? 0
    if (available < requested) {
      throw new OfflineStockError(
        'INSUFFICIENT_STOCK',
        `Only ${available} units are reserved as sellable on this device.`,
        {
          productId: line.productId,
          requestedQuantity: requested,
          sellableQuantity: available,
        },
      )
    }
    row!.quantity -= requested
    return [{ productId: line.productId, batchId: line.batchId, quantity: requested }]
  }

  const candidates = [...remaining.values()]
    .filter((row) => row.productId === line.productId && row.quantity > 0)
    .sort((a, b) => String(a.expiryDate ?? '9999').localeCompare(String(b.expiryDate ?? '9999')))

  const sellable = candidates.reduce((sum, row) => sum + row.quantity, 0)
  if (sellable < requested) {
    throw new OfflineStockError(
      'INSUFFICIENT_STOCK',
      `Only ${sellable} units are reserved as sellable on this device.`,
      {
        productId: line.productId,
        requestedQuantity: requested,
        sellableQuantity: sellable,
      },
    )
  }

  let left = requested
  const allocated: StockReservation[] = []
  for (const row of candidates) {
    if (left <= 0) break
    const take = Math.min(row.quantity, left)
    row.quantity -= take
    left -= take
    allocated.push({ productId: line.productId, batchId: row.batchId, quantity: take })
  }
  return allocated
}

/**
 * SQLite implementation shared by Expo and the Node durability tests.
 * `synchronous=FULL` makes a resolved commit mean SQLite has flushed its WAL record.
 */
export class SQLiteSyncOutboxStore implements SyncOutboxStore {
  private initialization: Promise<void> | null = null

  constructor(
    private readonly database: SyncSQLiteConnection,
    private readonly codec?: CommandJsonCodec,
  ) {}

  private async encodeCommand(json: string): Promise<string> {
    return this.codec ? this.codec.encode(json) : json
  }

  private async decodeCommand(stored: string): Promise<string> {
    return this.codec ? this.codec.decode(stored) : stored
  }

  private async hydrate(row: OutboxRow): Promise<SyncOutboxRecord> {
    return rowToRecord(row, await this.decodeCommand(row.command_json))
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.database.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS synapse_sync_outbox (
          command_id TEXT PRIMARY KEY NOT NULL,
          tenant_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          command_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('queued','syncing','applied','acknowledged','conflict','rejected')
          ),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          server_ack_id TEXT,
          applied_at TEXT,
          checkpoint TEXT,
          response_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS synapse_sync_outbox_tenant_status_idx
          ON synapse_sync_outbox (tenant_id, status, created_at);
        CREATE TABLE IF NOT EXISTS synapse_sync_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS synapse_stock_snapshot (
          tenant_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          expiry_date TEXT,
          captured_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, product_id, batch_id)
        );
        CREATE TABLE IF NOT EXISTS synapse_stock_reservations (
          command_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          PRIMARY KEY (command_id, product_id, batch_id)
        );
        CREATE INDEX IF NOT EXISTS synapse_stock_reservations_tenant_idx
          ON synapse_stock_reservations (tenant_id);
        CREATE TABLE IF NOT EXISTS synapse_catalogue_cache (
          tenant_id TEXT PRIMARY KEY NOT NULL,
          products_json TEXT NOT NULL,
          captured_at TEXT NOT NULL
        );
      `)
    }
    return this.initialization
  }

  async persist(command: SyncCommand): Promise<SyncPersistResult> {
    await this.initialize()
    return this.transaction((transaction) => this.persistInTransaction(transaction, command))
  }

  async persistSale(
    command: SyncCommand,
    lines: SaleStockLine[],
    options: { now?: Date; maxAgeMs?: number } = {},
  ): Promise<SyncPersistResult> {
    await this.initialize()
    return this.transaction(async (transaction) => {
      const existing = await transaction.getFirstAsync<{ command_id: string }>(
        'SELECT command_id FROM synapse_sync_outbox WHERE command_id = ?',
        [command.commandId],
      )
      if (existing) {
        return this.persistInTransaction(transaction, command)
      }

      await this.assertFreshSnapshot(transaction, command.tenantId, options)
      const remaining = await this.loadRemainingStock(transaction, command.tenantId)
      const reservations: StockReservation[] = []
      for (const line of lines) {
        reservations.push(...allocateLocalFefo(remaining, line))
      }

      const persisted = await this.persistInTransaction(transaction, command)
      if (persisted.outcome !== 'inserted') {
        return persisted
      }

      for (const reservation of reservations) {
        await transaction.runAsync(
          `INSERT INTO synapse_stock_reservations (
            command_id, tenant_id, product_id, batch_id, quantity
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            command.commandId,
            command.tenantId,
            reservation.productId,
            reservation.batchId,
            reservation.quantity,
          ],
        )
      }
      return persisted
    })
  }

  async replaceCatalogue(
    tenantId: string,
    products: CatalogueProduct[],
    capturedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.initialize()
    await this.transaction(async (transaction) => {
      await transaction.runAsync(`DELETE FROM synapse_stock_snapshot WHERE tenant_id = ?`, [
        tenantId,
      ])
      for (const product of products) {
        const batches = product.batches ?? []
        if (batches.length === 0) continue
        for (const batch of batches) {
          if (!batch.id) continue
          await transaction.runAsync(
            `INSERT INTO synapse_stock_snapshot (
              tenant_id, product_id, batch_id, quantity, expiry_date, captured_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              tenantId,
              product.id,
              batch.id,
              Math.max(0, Math.trunc(Number(batch.quantity) || 0)),
              batch.expiryDate ?? null,
              capturedAt,
            ],
          )
        }
      }
      await transaction.runAsync(
        `INSERT INTO synapse_catalogue_cache (tenant_id, products_json, captured_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           products_json = excluded.products_json,
           captured_at = excluded.captured_at`,
        [tenantId, JSON.stringify(products), capturedAt],
      )
    })
  }

  async getCatalogue(
    tenantId: string,
    options: { now?: Date; maxAgeMs?: number } = {},
  ): Promise<{ products: CatalogueProduct[]; capturedAt: string; stale: boolean } | null> {
    await this.initialize()
    const row = await this.database.getFirstAsync<{ products_json: string; captured_at: string }>(
      'SELECT products_json, captured_at FROM synapse_catalogue_cache WHERE tenant_id = ?',
      [tenantId],
    )
    if (!row) return null
    const maxAgeMs = options.maxAgeMs ?? OFFLINE_STOCK_MAX_AGE_MS
    const age = (options.now ?? new Date()).getTime() - Date.parse(row.captured_at)
    return {
      products: JSON.parse(row.products_json) as CatalogueProduct[],
      capturedAt: row.captured_at,
      stale: !Number.isFinite(age) || age > maxAgeMs,
    }
  }

  async getSellableMap(tenantId: string): Promise<Map<string, number>> {
    await this.initialize()
    return this.transaction(async (transaction) => {
      const remaining = await this.loadRemainingStock(transaction, tenantId)
      const byProduct = new Map<string, number>()
      for (const row of remaining.values()) {
        byProduct.set(row.productId, (byProduct.get(row.productId) ?? 0) + row.quantity)
      }
      return byProduct
    })
  }

  async get(commandId: string): Promise<SyncOutboxRecord | null> {
    await this.initialize()
    const row = await this.database.getFirstAsync<OutboxRow>(
      'SELECT * FROM synapse_sync_outbox WHERE command_id = ?',
      [commandId],
    )
    return row ? this.hydrate(row) : null
  }

  async listReady(tenantId: string, limit: number): Promise<SyncOutboxRecord[]> {
    await this.initialize()
    const rows = await this.database.getAllAsync<OutboxRow>(
      `SELECT * FROM synapse_sync_outbox
       WHERE tenant_id = ? AND status IN (${READY_STATUSES})
       ORDER BY created_at ASC
       LIMIT ?`,
      [tenantId, limit],
    )
    return Promise.all(rows.map((row) => this.hydrate(row)))
  }

  async listCommands(tenantId: string): Promise<OfflineOutboxListItem[]> {
    await this.initialize()
    const rows = await this.database.getAllAsync<OutboxRow>(
      `SELECT * FROM synapse_sync_outbox
       WHERE tenant_id = ? AND status != 'acknowledged'
       ORDER BY created_at DESC
       LIMIT 100`,
      [tenantId],
    )
    return Promise.all(
      rows.map(async (row) => {
        const command = JSON.parse(await this.decodeCommand(row.command_json)) as SyncCommand
        return {
          commandId: row.command_id,
          commandType: String(command.commandType),
          status: row.status,
          lastError: row.last_error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          attemptCount: Number(row.attempt_count),
        }
      }),
    )
  }

  async markSyncing(commandId: string): Promise<void> {
    await this.update(
      `status = 'syncing', attempt_count = attempt_count + 1, last_error = NULL`,
      commandId,
    )
  }

  async markQueued(commandId: string, error: string): Promise<void> {
    await this.update(`status = 'queued', last_error = ?`, commandId, [error])
  }

  async markApplied(
    commandId: string,
    result: typeof ACK_RESULT,
  ): Promise<void> {
    await this.update(
      `status = 'applied', last_error = NULL, server_ack_id = ?,
       applied_at = ?, checkpoint = ?, response_json = ?`,
      commandId,
      [
        result.serverAckId,
        result.checkpoint,
        result.checkpoint,
        result.response === undefined ? null : JSON.stringify(result.response),
      ],
    )
  }

  async acknowledge(
    commandId: string,
    tenantId: string,
    result: typeof ACK_RESULT,
  ): Promise<void> {
    await this.initialize()
    await this.transaction(async (transaction) => {
      const now = new Date().toISOString()
      await transaction.runAsync(
        `UPDATE synapse_sync_outbox
         SET status = 'acknowledged', last_error = NULL, updated_at = ?
         WHERE command_id = ?`,
        [now, commandId],
      )
      await transaction.runAsync(
        `INSERT INTO synapse_sync_metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [`checkpoint:${tenantId}`, result.checkpoint, now],
      )
      await this.consumeReservations(transaction, commandId, tenantId)
    })
  }

  async markConflict(
    commandId: string,
    conflict: SyncConflict,
    error?: string,
  ): Promise<void> {
    await this.initialize()
    await this.transaction(async (transaction) => {
      const now = new Date().toISOString()
      await transaction.runAsync(
        `UPDATE synapse_sync_outbox
         SET status = 'conflict', last_error = ?, updated_at = ?
         WHERE command_id = ?`,
        [error ?? conflict.reason, now, commandId],
      )
      await this.releaseReservations(transaction, commandId)
    })
  }

  async markRejected(commandId: string, reason: string): Promise<void> {
    await this.initialize()
    await this.transaction(async (transaction) => {
      const now = new Date().toISOString()
      await transaction.runAsync(
        `UPDATE synapse_sync_outbox
         SET status = 'rejected', last_error = ?, updated_at = ?
         WHERE command_id = ?`,
        [reason, now, commandId],
      )
      await this.releaseReservations(transaction, commandId)
    })
  }

  async getCheckpoint(tenantId: string): Promise<string | null> {
    await this.initialize()
    const row = await this.database.getFirstAsync<{ value: string }>(
      'SELECT value FROM synapse_sync_metadata WHERE key = ?',
      [`checkpoint:${tenantId}`],
    )
    return row?.value ?? null
  }

  async status(tenantId: string): Promise<OfflineSyncStatus> {
    await this.initialize()
    const rows = await this.database.getAllAsync<{ status: SyncOutboxStatus; count: number }>(
      `SELECT status, COUNT(*) AS count
       FROM synapse_sync_outbox
       WHERE tenant_id = ? AND status != 'acknowledged'
       GROUP BY status`,
      [tenantId],
    )
    const result: OfflineSyncStatus = { pending: 0, rejected: 0, conflicts: 0 }
    for (const row of rows) {
      if (row.status === 'rejected') result.rejected += Number(row.count)
      else if (row.status === 'conflict') result.conflicts += Number(row.count)
      else result.pending += Number(row.count)
    }
    return result
  }

  private async persistInTransaction(
    transaction: SyncSQLiteConnection,
    command: SyncCommand,
  ): Promise<SyncPersistResult> {
    const existing = await transaction.getFirstAsync<OutboxRow>(
      'SELECT * FROM synapse_sync_outbox WHERE command_id = ?',
      [command.commandId],
    )

    if (existing) {
      const existingRecord = await this.hydrate(existing)
      const resolution = resolveSyncConflict({
        existing: {
          commandId: existing.command_id,
          payloadHash: existing.payload_hash,
          status: existing.status,
        },
        incoming: { commandId: command.commandId, payloadHash: command.payloadHash },
        commandType: command.commandType,
      })

      if (existing.tenant_id !== command.tenantId || resolution !== 'replay') {
        const conflict: SyncConflict =
          resolution === 'replay'
            ? { policy: 'human_review', reason: 'idempotency_mismatch' }
            : resolution
        if (existing.tenant_id === command.tenantId) {
          const updatedAt = new Date().toISOString()
          await transaction.runAsync(
            `UPDATE synapse_sync_outbox
             SET status = 'conflict', last_error = ?, updated_at = ?
             WHERE command_id = ?`,
            [conflict.reason, updatedAt, command.commandId],
          )
          existingRecord.status = 'conflict'
          existingRecord.lastError = conflict.reason
          existingRecord.updatedAt = updatedAt
          await this.releaseReservations(transaction, command.commandId)
        }
        return { outcome: 'conflict', record: existingRecord, conflict }
      }

      return { outcome: 'replay', record: existingRecord }
    }

    const now = new Date().toISOString()
    await transaction.runAsync(
      `INSERT INTO synapse_sync_outbox (
        command_id, tenant_id, payload_hash, command_json, status,
        attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
      [
        command.commandId,
        command.tenantId,
        command.payloadHash,
        await this.encodeCommand(JSON.stringify(command)),
        now,
        now,
      ],
    )
    return {
      outcome: 'inserted',
      record: {
        command,
        status: 'queued',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    }
  }

  private async assertFreshSnapshot(
    transaction: SyncSQLiteConnection,
    tenantId: string,
    options: { now?: Date; maxAgeMs?: number },
  ): Promise<void> {
    const captured = await transaction.getFirstAsync<{ captured_at: string }>(
      'SELECT captured_at FROM synapse_catalogue_cache WHERE tenant_id = ?',
      [tenantId],
    )
    if (!captured) {
      throw new OfflineStockError(
        'OFFLINE_STOCK_STALE',
        'No stock cache on this device. Connect once to download sellable stock before selling offline.',
      )
    }
    const maxAgeMs = options.maxAgeMs ?? OFFLINE_STOCK_MAX_AGE_MS
    const age = (options.now ?? new Date()).getTime() - Date.parse(captured.captured_at)
    if (!Number.isFinite(age) || age > maxAgeMs) {
      throw new OfflineStockError(
        'OFFLINE_STOCK_STALE',
        'Cached stock is too old to sell offline. Reconnect and refresh inventory.',
      )
    }
  }

  private async loadRemainingStock(
    transaction: SyncSQLiteConnection,
    tenantId: string,
  ): Promise<
    Map<string, { productId: string; batchId: string; quantity: number; expiryDate: string | null }>
  > {
    const snapshot = await transaction.getAllAsync<{
      product_id: string
      batch_id: string
      quantity: number
      expiry_date: string | null
    }>(
      `SELECT product_id, batch_id, quantity, expiry_date
       FROM synapse_stock_snapshot WHERE tenant_id = ?`,
      [tenantId],
    )
    const holds = await transaction.getAllAsync<{
      product_id: string
      batch_id: string
      quantity: number
    }>(
      `SELECT r.product_id, r.batch_id, SUM(r.quantity) AS quantity
       FROM synapse_stock_reservations r
       INNER JOIN synapse_sync_outbox o ON o.command_id = r.command_id
       WHERE r.tenant_id = ? AND o.status IN (${HOLD_STATUSES})
       GROUP BY r.product_id, r.batch_id`,
      [tenantId],
    )
    const remaining = new Map<
      string,
      { productId: string; batchId: string; quantity: number; expiryDate: string | null }
    >()
    for (const row of snapshot) {
      remaining.set(snapshotKey(row.product_id, row.batch_id), {
        productId: row.product_id,
        batchId: row.batch_id,
        quantity: Number(row.quantity),
        expiryDate: row.expiry_date,
      })
    }
    for (const hold of holds) {
      const key = snapshotKey(hold.product_id, hold.batch_id)
      const current = remaining.get(key)
      if (!current) continue
      current.quantity = Math.max(0, current.quantity - Number(hold.quantity))
    }
    return remaining
  }

  private async consumeReservations(
    transaction: SyncSQLiteConnection,
    commandId: string,
    tenantId: string,
  ): Promise<void> {
    const rows = await transaction.getAllAsync<{
      product_id: string
      batch_id: string
      quantity: number
    }>(
      `SELECT product_id, batch_id, quantity FROM synapse_stock_reservations WHERE command_id = ?`,
      [commandId],
    )
    for (const row of rows) {
      await transaction.runAsync(
        `UPDATE synapse_stock_snapshot
         SET quantity = MAX(0, quantity - ?)
         WHERE tenant_id = ? AND product_id = ? AND batch_id = ?`,
        [Number(row.quantity), tenantId, row.product_id, row.batch_id],
      )
    }
    await this.releaseReservations(transaction, commandId)
  }

  private async releaseReservations(
    transaction: SyncSQLiteConnection,
    commandId: string,
  ): Promise<void> {
    await transaction.runAsync(`DELETE FROM synapse_stock_reservations WHERE command_id = ?`, [
      commandId,
    ])
  }

  private async update(
    assignments: string,
    commandId: string,
    values: SQLiteValue[] = [],
  ): Promise<void> {
    await this.initialize()
    await this.database.runAsync(
      `UPDATE synapse_sync_outbox SET ${assignments}, updated_at = ? WHERE command_id = ?`,
      [...values, new Date().toISOString(), commandId],
    )
  }

  private async transaction<T>(
    task: (transaction: SyncSQLiteConnection) => Promise<T>,
  ): Promise<T> {
    let result: T | undefined
    if (this.database.withExclusiveTransactionAsync) {
      await this.database.withExclusiveTransactionAsync(async (transaction) => {
        result = await task(transaction)
      })
    } else {
      await this.database.withTransactionAsync(async () => {
        result = await task(this.database)
      })
    }
    return result as T
  }
}
