/**
 * Outbox relay.
 *
 * `synapse_domain_events` is written by application code and, until this file,
 * nothing drained it: the table accumulated `pending` rows forever. The relay is
 * the drain. It is deliberately a plain function over injected collaborators so
 * that every branch — success, retry, dead-letter, open circuit, thrown
 * exception — can be exercised without a database or a network.
 *
 * Delivery semantics, stated once so callers can rely on them:
 *
 *   - At-least-once. A message is marked published only after the connector
 *     reports success. A crash between "peer accepted" and "row marked" replays
 *     the message, which is why the idempotency key is part of the contract.
 *   - No silent loss. A message leaves the queue in exactly one of three ways:
 *     published, dead-lettered with an error recorded, or still pending.
 *   - One message per push call, so `context.idempotencyKey` is unambiguously
 *     that message's key. Connectors that batch internally should derive
 *     per-item keys from it.
 */

import type {
  Connector,
  ConnectorResult,
  OutboxClaim,
  OutboxStore,
} from "./contract"
import type { CircuitBreaker } from "./breaker"
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  shouldRetry,
  type RetryPolicy,
} from "./backoff"

export interface RelayPolicy {
  batchSize: number
  retry: RetryPolicy
}

export const DEFAULT_RELAY_POLICY: RelayPolicy = {
  batchSize: 50,
  retry: DEFAULT_RETRY_POLICY,
}

export type RelaySkipReason = "circuit_open" | "no_push_capability" | "unknown_connector"

export interface RelaySummary {
  connectorId: string
  claimed: number
  published: number
  retried: number
  dead: number
  /** Claimed-but-not-attempted, e.g. the circuit opened mid-batch. Left pending. */
  skipped: number
  skipReason?: RelaySkipReason
  errors: string[]
}

function emptySummary(connectorId: string): RelaySummary {
  return { connectorId, claimed: 0, published: 0, retried: 0, dead: 0, skipped: 0, errors: [] }
}

function describeFailure(code: string, message: string): string {
  const bounded = message.length > 500 ? `${message.slice(0, 500)}…` : message
  return `${code}: ${bounded}`
}

export interface RelayConnectorInput<TPush = unknown> {
  connector: Connector<unknown, TPush>
  store: OutboxStore<TPush>
  /** Fixed for the duration of a run; never reads the wall clock itself. */
  now: Date
  policy?: RelayPolicy
  breaker?: CircuitBreaker
  /** Injected for deterministic backoff in tests. */
  random?: () => number
}

/**
 * Deliver one connector's due messages. Never throws: a connector that blows up
 * becomes a recorded retryable failure, not a crashed relay.
 */
export async function relayConnector<TPush>(input: RelayConnectorInput<TPush>): Promise<RelaySummary> {
  const policy = input.policy ?? DEFAULT_RELAY_POLICY
  const descriptor = input.connector.describe()
  const summary = emptySummary(descriptor.id)

  if (!input.connector.push || !descriptor.capabilities.includes("push")) {
    summary.skipReason = "no_push_capability"
    return summary
  }
  if (input.breaker && input.breaker.state(descriptor.id, input.now) === "open") {
    summary.skipReason = "circuit_open"
    return summary
  }

  let claims: Array<OutboxClaim<TPush>>
  try {
    claims = await input.store.claim(descriptor.id, policy.batchSize, input.now)
  } catch (error) {
    summary.errors.push(`claim_failed: ${error instanceof Error ? error.message : String(error)}`)
    return summary
  }
  summary.claimed = claims.length
  const maxAttempts = descriptor.maxAttempts ?? policy.retry.maxAttempts

  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index]
    if (!claim) continue

    // A half-open circuit grants exactly one trial. If it was already spent
    // earlier in this batch, the rest of the batch stays pending.
    if (input.breaker && !input.breaker.canAttempt(descriptor.id, input.now)) {
      summary.skipped = claims.length - index
      summary.skipReason = "circuit_open"
      break
    }

    const attempt = claim.attempt > 0 ? claim.attempt : claim.message.attempts + 1
    let result: ConnectorResult<{ delivered: number }>
    try {
      result = await input.connector.push([claim.message.payload], {
        idempotencyKey: claim.message.idempotencyKey,
        attempt,
      })
    } catch (error) {
      result = {
        ok: false,
        code: "CONNECTOR_THREW",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      }
    }

    if (result.ok) {
      try {
        await input.store.markDelivered(claim.message.id, input.now)
        summary.published += 1
        input.breaker?.recordSuccess(descriptor.id)
      } catch (error) {
        // The peer accepted but we failed to record it. Leaving the message
        // unmarked means it will be replayed; saying "published" here would be a
        // lie, so it is reported as an error and stays queued.
        summary.errors.push(
          `mark_published_failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      continue
    }

    const error = describeFailure(result.code, result.message)
    const retryable = shouldRetry(result)
    if (!retryable || attempt >= maxAttempts) {
      try {
        await input.store.markFailed(claim.message.id, input.now, error, null)
        summary.dead += 1
      } catch (storeError) {
        summary.errors.push(
          `mark_dead_failed: ${storeError instanceof Error ? storeError.message : String(storeError)}`,
        )
      }
      // A validation failure means the peer is reachable; it must not count
      // toward opening the circuit.
      continue
    }

    const retryAt = new Date(input.now.getTime() + backoffDelayMs(attempt, policy.retry, input.random))
    try {
      await input.store.markFailed(claim.message.id, input.now, error, retryAt)
      summary.retried += 1
      input.breaker?.recordFailure(descriptor.id, input.now)
    } catch (storeError) {
      summary.errors.push(
        `mark_retry_failed: ${storeError instanceof Error ? storeError.message : String(storeError)}`,
      )
    }
  }

  return summary
}

/** Relay every registered connector. One failing connector cannot stop the rest. */
export async function relayAll<TPush>(input: {
  connections: Array<Omit<RelayConnectorInput<TPush>, "policy" | "breaker" | "random">>
  policy?: RelayPolicy
  breaker?: CircuitBreaker
  random?: () => number
}): Promise<RelaySummary[]> {
  const summaries: RelaySummary[] = []
  for (const connection of input.connections) {
    summaries.push(
      await relayConnector({
        ...connection,
        policy: input.policy,
        breaker: input.breaker,
        random: input.random,
      }),
    )
  }
  return summaries
}

// ---------------------------------------------------------------------------
// Pull direction
// ---------------------------------------------------------------------------

export type PullStopReason = "exhausted" | "page_limit" | "failed" | "no_pull_capability" | "cursor_stalled"

export interface PullSummary {
  connectorId: string
  pages: number
  items: number
  /** The cursor now safe to resume from. Equal to the input on failure. */
  cursor: string | null
  stoppedBecause: PullStopReason
  errors: string[]
}

/**
 * Read one connector forward from `cursor`.
 *
 * Two rules matter more than throughput:
 *   - The cursor is persisted only after a page is accepted, and never on a
 *     failed pull. A crash therefore re-reads at most one page.
 *   - A page claiming `hasMore` without a new cursor is treated as a stall
 *     rather than a reason to loop, because it would spin forever.
 */
export async function pullConnector<TPull>(input: {
  connector: Connector<TPull, unknown>
  store?: Pick<OutboxStore, "saveCursor">
  cursor: string | null
  now: Date
  maxPages?: number
}): Promise<PullSummary> {
  const descriptor = input.connector.describe()
  const summary: PullSummary = {
    connectorId: descriptor.id,
    pages: 0,
    items: 0,
    cursor: input.cursor,
    stoppedBecause: "exhausted",
    errors: [],
  }

  if (!input.connector.pull || !descriptor.capabilities.includes("pull")) {
    summary.stoppedBecause = "no_pull_capability"
    return summary
  }

  const maxPages = input.maxPages ?? 20

  for (let page = 0; page < maxPages; page += 1) {
    let result
    try {
      result = await input.connector.pull(summary.cursor)
    } catch (error) {
      summary.errors.push(
        `pull_threw: ${error instanceof Error ? error.message : String(error)}`,
      )
      summary.stoppedBecause = "failed"
      return summary
    }

    if (!result.ok) {
      summary.errors.push(describeFailure(result.code, result.message))
      summary.stoppedBecause = "failed"
      return summary
    }

    summary.pages += 1
    summary.items += result.data.items.length

    if (result.data.nextCursor !== null) {
      try {
        await input.store?.saveCursor?.(descriptor.id, result.data.nextCursor, input.now)
        summary.cursor = result.data.nextCursor
      } catch (error) {
        // Without a durable cursor, continuing would re-read this page forever
        // on the next run. Stop where we are.
        summary.errors.push(
          `cursor_save_failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        summary.stoppedBecause = "failed"
        return summary
      }
    }

    if (!result.data.hasMore) {
      summary.stoppedBecause = "exhausted"
      return summary
    }
    if (result.data.nextCursor === null) {
      summary.stoppedBecause = "cursor_stalled"
      summary.errors.push("page_reported_more_without_cursor")
      return summary
    }
    if (page === maxPages - 1) {
      summary.stoppedBecause = "page_limit"
    }
  }

  return summary
}
