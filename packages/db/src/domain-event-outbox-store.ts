/**
 * Durable outbox store over `public.synapse_domain_events`.
 *
 * Implements the `OutboxStore` contract from `@synapse/interop` so the relay can
 * drain real rows instead of the in-memory stand-in. Three constraints shape it,
 * all of them facts about the schema rather than preferences:
 *
 *   1. The table has no connector column. A row is a domain event, not a
 *      delivery, so this store assumes ONE connector per tenant — the pilot
 *      reality (a single Tally instance). Fan-out of one event to several
 *      connectors needs a delivery table and is not attempted here.
 *   2. Scheduling and leases live in `next_attempt_at` and `locked_until`, added
 *      by migration 20261026180000. That migration is PREPARED, NOT APPLIED, so
 *      this store must not be wired to a live relay until it lands.
 *   3. `packages/db/src/types.ts` does not know this table, so the Supabase
 *      client is adapted through `EventDeliveryClient` rather than generated
 *      types. The adapter is the only part without unit coverage; it is thin on
 *      purpose so that what it does is readable.
 *
 * Nothing here retries, classifies or decides. It reads and writes rows; the
 * policy lives in `relay.ts`, which is where the tests are.
 */

import type { OutboxClaim, OutboxMessage, OutboxStore } from "@synapse/interop"

export interface DueEventRow {
  event_id: string
  tenant_id: string
  idempotency_key: string
  payload: Record<string, unknown>
  retry_count: number | null
}

export interface EventDeliveryClient {
  /** Rows claimable now: pending/failed, not yet due later, not leased. */
  listDue(input: { tenantId: string; limit: number; now: Date }): Promise<{ rows: DueEventRow[]; error: string | null }>
  /** Take a lease so a second worker does not claim the same rows. */
  lease(input: { ids: string[]; until: Date }): Promise<{ error: string | null }>
  markPublished(input: { id: string; now: Date }): Promise<{ error: string | null }>
  markFailed(input: {
    id: string
    now: Date
    error: string
    nextAttemptAt: Date | null
    /**
     * Absolute value to store, not a delta. PostgREST cannot express
     * `retry_count = retry_count + 1` in an update payload, so the store computes
     * the next count from the lease it holds.
     */
    retryCount: number
  }): Promise<{ error: string | null }>
}

export interface DurableOutboxStore extends OutboxStore<unknown> {
  /** The tenant this store is scoped to. Stated so callers cannot forget it. */
  readonly tenantId: string
}

/**
 * `connectorId` is accepted for contract compatibility but does not filter rows:
 * the table carries no connector. A store handed the wrong connector id would
 * otherwise silently drain another connector's queue.
 */
export function createDurableOutboxStore(
  client: EventDeliveryClient,
  options: { tenantId: string; leaseMs?: number },
): DurableOutboxStore {
  const tenantId = options.tenantId
  const leaseMs = options.leaseMs ?? 60_000
  /** retry_count as leased, so `markFailed` can store an absolute next value. */
  const leasedCounts = new Map<string, number>()

  function toClaim(row: DueEventRow): OutboxClaim<unknown> {
    const message: OutboxMessage<unknown> = {
      id: row.event_id,
      tenantId: row.tenant_id,
      connectorId: "",
      idempotencyKey: row.idempotency_key,
      payload: row.payload,
      attempts: row.retry_count ?? 0,
    }
    // `retry_count` counts failures, so the attempt being made is the next one.
    return { message, attempt: (row.retry_count ?? 0) + 1 }
  }

  return {
    tenantId,

    async claim(connectorId, limit, now) {
      const listed = await client.listDue({ tenantId, limit, now })
      if (listed.error) throw new Error(`OUTBOX_LIST_DUE_FAILED: ${listed.error}`)

      const rows = listed.rows.filter((row) => row.tenant_id === tenantId)
      if (rows.length === 0) return []

      const leased = await client.lease({
        ids: rows.map((row) => row.event_id),
        until: new Date(now.getTime() + leaseMs),
      })
      if (leased.error) throw new Error(`OUTBOX_LEASE_FAILED: ${leased.error}`)

      return rows.map((row) => {
        const claim = toClaim(row)
        leasedCounts.set(row.event_id, row.retry_count ?? 0)
        return { attempt: claim.attempt, message: { ...claim.message, connectorId } }
      })
    },

    async markDelivered(id, now) {
      leasedCounts.delete(id)
      const result = await client.markPublished({ id, now })
      if (result.error) throw new Error(`OUTBOX_MARK_PUBLISHED_FAILED: ${result.error}`)
    },

    async markFailed(id, now, error, retryAt) {
      const retryCount = (leasedCounts.get(id) ?? 0) + 1
      leasedCounts.delete(id)
      const result = await client.markFailed({ id, now, error, nextAttemptAt: retryAt, retryCount })
      if (result.error) throw new Error(`OUTBOX_MARK_FAILED_FAILED: ${result.error}`)
    },
  }
}
