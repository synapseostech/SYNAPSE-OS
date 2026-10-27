/**
 * In-memory outbox store.
 *
 * This is NOT durable and must never back a real deployment — a process restart
 * loses every queued message. It exists so the relay's policy can be tested and
 * so a local demo can be exercised end to end. The production implementation
 * belongs over `public.synapse_domain_events`, whose `status`, `retry_count`,
 * `last_error` and `published_at` columns already match this shape.
 *
 * Claim semantics mirror a row lease: claiming sets a `retry_at` in the future so
 * a second worker in the same window cannot take the same message.
 */

import type { OutboxClaim, OutboxMessage, OutboxStore } from "./contract"

export interface SeedMessage<TPush = unknown> {
  id: string
  tenantId: string
  connectorId: string
  idempotencyKey: string
  payload: TPush
}

interface Row<TPush> extends OutboxMessage<TPush> {
  status: "pending" | "published" | "failed" | "dead"
  lastError: string | null
  retryAt: Date | null
  publishedAt: Date | null
  /**
   * Claim lease, deliberately separate from `retryAt`. A lease means "a worker
   * has this row"; it is not a delivery attempt. Conflating the two would make a
   * claimed-but-never-pushed message look like it had already been tried.
   */
  leasedUntil: Date | null
}

export interface InMemoryOutboxStore<TPush = unknown> extends OutboxStore<TPush> {
  /** The mutable backing rows, for assertions. Treat as read-only. */
  rows(): ReadonlyArray<Readonly<Row<TPush>>>
  cursors(): Readonly<Record<string, string>>
  /** Add a message after construction, as application code would. */
  enqueue(message: SeedMessage<TPush>): void
}

export function createInMemoryOutboxStore<TPush = unknown>(
  seed: Array<SeedMessage<TPush>> = [],
  options: { leaseMs?: number } = {},
): InMemoryOutboxStore<TPush> {
  const leaseMs = options.leaseMs ?? 30_000
  const store: Row<TPush>[] = seed.map((message) => ({
    ...message,
    attempts: 0,
    status: "pending",
    lastError: null,
    retryAt: null,
    publishedAt: null,
    leasedUntil: null,
  }))
  const cursorMap: Record<string, string> = {}

  return {
    rows() {
      return store
    },
    cursors() {
      return cursorMap
    },
    enqueue(message) {
      store.push({
        ...message,
        attempts: 0,
        status: "pending",
        lastError: null,
        retryAt: null,
        publishedAt: null,
        leasedUntil: null,
      })
    },
    async claim(connectorId, limit, now): Promise<Array<OutboxClaim<TPush>>> {
      const due = store.filter(
        (row) =>
          row.connectorId === connectorId &&
          (row.status === "pending" || row.status === "failed") &&
          (row.retryAt === null || row.retryAt.getTime() <= now.getTime()) &&
          (row.leasedUntil === null || row.leasedUntil.getTime() <= now.getTime()),
      )
      const taken = due.slice(0, Math.max(0, limit))
      return taken.map((row) => {
        row.leasedUntil = new Date(now.getTime() + leaseMs)
        return {
          message: {
            id: row.id,
            tenantId: row.tenantId,
            connectorId: row.connectorId,
            idempotencyKey: row.idempotencyKey,
            payload: row.payload,
            attempts: row.attempts,
          },
          // The attempt about to be made. Counting it now would make a claimed
          // row that is never pushed look tried; `markFailed` does the counting.
          attempt: row.attempts + 1,
        }
      })
    },
    async markDelivered(id, now) {
      const row = store.find((candidate) => candidate.id === id)
      if (!row) return
      row.status = "published"
      row.publishedAt = now
      row.retryAt = null
      row.lastError = null
      row.leasedUntil = null
    },
    async markFailed(id, now, error, retryAt) {
      const row = store.find((candidate) => candidate.id === id)
      if (!row) return
      row.attempts += 1
      row.lastError = error
      row.retryAt = retryAt
      row.leasedUntil = null
      row.status = retryAt === null ? "dead" : "failed"
    },
    async saveCursor(connectorId, cursor, _now) {
      cursorMap[connectorId] = cursor
    },
  }
}
