import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SYNC_SCHEMA_VERSION,
  hashPayload,
  type SyncCommand,
} from '@synapse/db/sync-contract'
import {
  SyncPayloadConflictError,
  SyncRuntime,
  classifyApplyHttpFailure,
  type SyncApplyResult,
} from '@synapse/db/sync-runtime'
import {
  OFFLINE_STOCK_MAX_AGE_MS,
  OfflineStockError,
  SQLiteSyncOutboxStore,
  type SQLiteValue,
  type SyncSQLiteConnection,
} from '../../../app/lib/offline-store-core'

const UUID = {
  commandA: '11111111-1111-4111-8111-111111111111',
  commandB: '11111111-1111-4111-8111-111111111112',
  tenantA: '22222222-2222-4222-8222-222222222222',
  tenantB: '22222222-2222-4222-8222-222222222223',
  facility: '33333333-3333-4333-8333-333333333333',
  device: '44444444-4444-4444-8444-444444444444',
  actor: '55555555-5555-4555-8555-555555555555',
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class NodeSQLiteConnection implements SyncSQLiteConnection {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
  }

  async execAsync(source: string): Promise<void> {
    this.database.exec(source)
  }

  async runAsync(source: string, params: SQLiteValue[] = []): Promise<unknown> {
    return this.database.prepare(source).run(...params)
  }

  async getFirstAsync<T>(
    source: string,
    params: SQLiteValue[] = [],
  ): Promise<T | null> {
    return (this.database.prepare(source).get(...params) as T | undefined) ?? null
  }

  async getAllAsync<T>(
    source: string,
    params: SQLiteValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(source).all(...params) as T[]
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      await task()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.database.close()
  }
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'synapse-sync-'))
  temporaryDirectories.push(directory)
  return join(directory, 'outbox.sqlite')
}

async function command(
  overrides: Partial<SyncCommand> = {},
): Promise<SyncCommand> {
  const payload = overrides.payload ?? {
    paymentMethod: 'CASH',
    taxAmount: 0,
    items: [{ productId: UUID.facility, quantity: 1, unitPrice: 500 }],
  }
  return {
    commandId: UUID.commandA,
    commandType: 'pharmacy.sale.complete.v1',
    schemaVersion: SYNC_SCHEMA_VERSION,
    tenantId: UUID.tenantA,
    facilityId: UUID.facility,
    deviceId: UUID.device,
    actorId: UUID.actor,
    aggregateType: 'pharmacy_sale',
    aggregateId: UUID.commandA,
    capturedAtClient: '2026-08-19T12:00:00.000Z',
    payload,
    payloadHash: await hashPayload(payload),
    ...overrides,
  }
}

describe('durable pharmacy sync runtime', () => {
  it('commits before apply and survives a database/module restart', async () => {
    const path = databasePath()
    const firstConnection = new NodeSQLiteConnection(path)
    const firstStore = new SQLiteSyncOutboxStore(firstConnection)
    const firstRuntime = new SyncRuntime(UUID.tenantA, firstStore)
    const sale = await command()
    let applyCalls = 0

    const persisted = await firstRuntime.commit(sale)
    expect(persisted.status).toBe('queued')
    expect(applyCalls).toBe(0)
    firstConnection.close()

    const restartedConnection = new NodeSQLiteConnection(path)
    const restartedStore = new SQLiteSyncOutboxStore(restartedConnection)
    const recovered = await restartedStore.get(sale.commandId)
    expect(recovered?.command).toEqual(sale)
    expect(recovered?.status).toBe('queued')

    const restartedRuntime = new SyncRuntime(UUID.tenantA, restartedStore)
    await restartedRuntime.flush(async () => {
      applyCalls += 1
      return {
        outcome: 'applied',
        serverAckId: 'server-outbox-1',
        checkpoint: '2026-08-19T12:01:00.000Z',
      }
    })
    expect(applyCalls).toBe(1)
    expect((await restartedStore.get(sale.commandId))?.status).toBe('acknowledged')
    expect(await restartedRuntime.checkpoint()).toBe('2026-08-19T12:01:00.000Z')
    restartedConnection.close()
  })

  it('recovers an interrupted apply as an idempotent replay without a second local row', async () => {
    const path = databasePath()
    const firstConnection = new NodeSQLiteConnection(path)
    const firstStore = new SQLiteSyncOutboxStore(firstConnection)
    const sale = await command()
    await new SyncRuntime(UUID.tenantA, firstStore).commit(sale)
    await firstStore.markSyncing(sale.commandId)
    firstConnection.close()

    const restartedConnection = new NodeSQLiteConnection(path)
    const restartedStore = new SQLiteSyncOutboxStore(restartedConnection)
    const runtime = new SyncRuntime(UUID.tenantA, restartedStore)
    let applyCalls = 0
    const summary = await runtime.flush(async () => {
      applyCalls += 1
      return {
        outcome: 'replay',
        serverAckId: 'server-outbox-1',
        checkpoint: '2026-08-19T12:02:00.000Z',
      }
    })

    expect(summary.replayed).toBe(1)
    expect(applyCalls).toBe(1)
    await runtime.commit(sale)
    await runtime.flush(async () => {
      applyCalls += 1
      return {} as SyncApplyResult
    })
    expect(applyCalls).toBe(1)
    expect((await restartedStore.get(sale.commandId))?.attemptCount).toBe(2)
    restartedConnection.close()
  })

  it('moves a reused commandId with a different hash to human-review conflict', async () => {
    const path = databasePath()
    const connection = new NodeSQLiteConnection(path)
    const store = new SQLiteSyncOutboxStore(connection)
    const runtime = new SyncRuntime(UUID.tenantA, store)
    const original = await command()
    await runtime.commit(original)
    const changedPayload = { ...original.payload, taxAmount: 100 }
    const changed = await command({
      payload: changedPayload,
      payloadHash: await hashPayload(changedPayload),
    })

    await expect(runtime.commit(changed)).rejects.toBeInstanceOf(
      SyncPayloadConflictError,
    )
    const record = await store.get(original.commandId)
    expect(record?.status).toBe('conflict')
    expect(record?.command.payloadHash).toBe(original.payloadHash)
    connection.close()
  })

  it('keeps insufficient-stock commands rejected and never applied or checkpointed', async () => {
    const path = databasePath()
    const connection = new NodeSQLiteConnection(path)
    const store = new SQLiteSyncOutboxStore(connection)
    const runtime = new SyncRuntime(UUID.tenantA, store)
    const sale = await command()
    await runtime.commit(sale)

    const summary = await runtime.flush(async () => ({
      outcome: 'rejected',
      reason: 'insufficient_stock',
    }))
    const record = await store.get(sale.commandId)
    expect(summary.rejected).toBe(1)
    expect(record?.status).toBe('rejected')
    expect(record?.appliedAt).toBeNull()
    expect(record?.serverAckId).toBeNull()
    expect(await runtime.checkpoint()).toBeNull()
    connection.close()
  })

  it('flushes only commands from the active tenant', async () => {
    const path = databasePath()
    const connection = new NodeSQLiteConnection(path)
    const store = new SQLiteSyncOutboxStore(connection)
    const tenantA = new SyncRuntime(UUID.tenantA, store)
    const tenantB = new SyncRuntime(UUID.tenantB, store)
    const saleA = await command()
    const saleB = await command({
      commandId: UUID.commandB,
      aggregateId: UUID.commandB,
      tenantId: UUID.tenantB,
    })
    await tenantA.commit(saleA)
    await tenantB.commit(saleB)

    const applied: string[] = []
    await tenantA.flush(async (incoming) => {
      applied.push(incoming.commandId)
      return {
        outcome: 'applied',
        serverAckId: 'server-outbox-a',
        checkpoint: '2026-08-19T12:03:00.000Z',
      }
    })

    expect(applied).toEqual([saleA.commandId])
    expect((await store.get(saleA.commandId))?.status).toBe('acknowledged')
    expect((await store.get(saleB.commandId))?.status).toBe('queued')
    connection.close()
  })

  it('classifies lost-response retries as replay-safe and stock failures as rejected', () => {
    expect(classifyApplyHttpFailure(503)).toBe('retry')
    expect(classifyApplyHttpFailure(408)).toBe('retry')
    expect(classifyApplyHttpFailure(401)).toBe('retry')
    expect(classifyApplyHttpFailure(409, 'INSUFFICIENT_STOCK')).toBe('rejected')
    expect(classifyApplyHttpFailure(400, 'EXPIRED_BATCH_BLOCKED')).toBe('rejected')
    expect(classifyApplyHttpFailure(422)).toBe('rejected')
  })

  it('carries a second offline sale past the cached snapshot into the overdraft batch (case D)', async () => {
    const path = databasePath()
    const connection = new NodeSQLiteConnection(path)
    const store = new SQLiteSyncOutboxStore(connection)
    const productId = UUID.facility
    const batchId = UUID.device
    await store.replaceCatalogue(UUID.tenantA, [
      {
        id: productId,
        name: 'Amoxicillin',
        sku: 'AMX',
        barcode: null,
        price: 500,
        quantity: 5,
        batches: [{ id: batchId, batchNumber: 'B1', quantity: 5, expiryDate: '2027-01-01' }],
      },
    ])

    const first = await command({
      payload: {
        paymentMethod: 'CASH',
        taxAmount: 0,
        items: [{ productId, quantity: 3, unitPrice: 500, batchId }],
      },
    })
    first.payloadHash = await hashPayload(first.payload)
    await store.persistSale(first, [{ productId, quantity: 3, batchId }])

    const second = await command({
      commandId: UUID.commandB,
      aggregateId: UUID.commandB,
      payload: {
        paymentMethod: 'CASH',
        taxAmount: 0,
        items: [{ productId, quantity: 3, unitPrice: 500, batchId }],
      },
    })
    second.payloadHash = await hashPayload(second.payload)
    await store.persistSale(second, [{ productId, quantity: 3, batchId }])

    expect(await store.get(second.commandId)).not.toBeNull()
    const reservations = await connection.getAllAsync<{ batch_id: string; quantity: number }>(
      'SELECT batch_id, quantity FROM synapse_stock_reservations WHERE command_id = ?',
      [second.commandId],
    )
    expect(reservations).toEqual(
      expect.arrayContaining([
        { batch_id: batchId, quantity: 2 },
        { batch_id: 'NEG-STOCK', quantity: 1 },
      ]),
    )
    connection.close()
  })

  it('refuses offline sales when the stock snapshot is missing or stale', async () => {
    const path = databasePath()
    const connection = new NodeSQLiteConnection(path)
    const store = new SQLiteSyncOutboxStore(connection)
    const sale = await command()
    await expect(
      store.persistSale(sale, [{ productId: UUID.facility, quantity: 1, batchId: null }]),
    ).rejects.toBeInstanceOf(OfflineStockError)

    const capturedAt = new Date(Date.now() - OFFLINE_STOCK_MAX_AGE_MS - 1_000).toISOString()
    await store.replaceCatalogue(
      UUID.tenantA,
      [
        {
          id: UUID.facility,
          name: 'Amoxicillin',
          sku: 'AMX',
          barcode: null,
          price: 500,
          quantity: 5,
          batches: [
            { id: UUID.device, batchNumber: 'B1', quantity: 5, expiryDate: '2027-01-01' },
          ],
        },
      ],
      capturedAt,
    )
    await expect(
      store.persistSale(sale, [{ productId: UUID.facility, quantity: 1, batchId: UUID.device }]),
    ).rejects.toMatchObject({ code: 'OFFLINE_STOCK_STALE' })
    connection.close()
  })

  it('releases reserved stock when the server rejects the command', async () => {
    const path = databasePath()
    const connection = new NodeSQLiteConnection(path)
    const store = new SQLiteSyncOutboxStore(connection)
    const productId = UUID.facility
    const batchId = UUID.device
    await store.replaceCatalogue(UUID.tenantA, [
      {
        id: productId,
        name: 'Amoxicillin',
        sku: 'AMX',
        barcode: null,
        price: 500,
        quantity: 5,
        batches: [{ id: batchId, batchNumber: 'B1', quantity: 5, expiryDate: '2027-01-01' }],
      },
    ])
    const sale = await command({
      payload: {
        paymentMethod: 'CASH',
        taxAmount: 0,
        items: [{ productId, quantity: 5, unitPrice: 500, batchId }],
      },
    })
    sale.payloadHash = await hashPayload(sale.payload)
    await store.persistSale(sale, [{ productId, quantity: 5, batchId }])
    const runtime = new SyncRuntime(UUID.tenantA, store)
    await runtime.flush(async () => ({
      outcome: 'rejected',
      reason: 'insufficient_stock',
    }))

    const second = await command({
      commandId: UUID.commandB,
      aggregateId: UUID.commandB,
      payload: {
        paymentMethod: 'CASH',
        taxAmount: 0,
        items: [{ productId, quantity: 5, unitPrice: 500, batchId }],
      },
    })
    second.payloadHash = await hashPayload(second.payload)
    const persisted = await store.persistSale(second, [{ productId, quantity: 5, batchId }])
    expect(persisted.outcome).toBe('inserted')
    connection.close()
  })
})
