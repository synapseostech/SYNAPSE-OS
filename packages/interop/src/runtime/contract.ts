/**
 * Connector contract.
 *
 * The baseline (docs/architecture/INTEROP_BASELINE_2026-10-25.md) records that
 * the canonical model and the adapter ladder exist but "the connector runtime
 * does not": `synapse_adapters` is schema-only, the domain-event outbox is an
 * in-memory list, and nothing drains it. This is the boundary those missing
 * pieces are built against.
 *
 * Three properties are part of the contract rather than left to implementations:
 *
 *   - Delivery is at-least-once. A connector may see the same idempotency key
 *     more than once, and must behave as though it saw it once.
 *   - A failure must say whether it is retryable. An unclassified failure is
 *     treated as retryable, because dropping a message silently is worse than
 *     delivering it twice.
 *   - Nothing here performs I/O on its own. Store, connector and clock are all
 *     injected, so the runtime is testable without a network or a database.
 */

export type ConnectorKind = 'tally' | 'dhis2' | 'fhir' | 'hl7v2' | 'openmrs' | 'ugandaemr' | 'rest' | 'other'

export type ConnectorCapability = 'pull' | 'push' | 'health'

export interface ConnectorDescriptor {
  id: string
  tenantId: string
  kind: ConnectorKind
  displayName: string
  capabilities: ConnectorCapability[]
  /** Attempts before the message is dead-lettered. Defaults to the runtime policy. */
  maxAttempts?: number
}

export interface ConnectorFailure {
  ok: false
  code: string
  message: string
  /**
   * Whether another attempt could succeed. Connectors should set this
   * deliberately; when unsure, `true` is the safe answer.
   */
  retryable: boolean
}

export interface ConnectorSuccess<T> {
  ok: true
  data: T
}

export type ConnectorResult<T> = ConnectorSuccess<T> | ConnectorFailure

export interface PushContext {
  /**
   * Stable per outbox message. A connector that has already processed this key
   * must report success without applying the change again.
   */
  idempotencyKey: string
  attempt: number
}

export interface PullPage<T> {
  items: T[]
  /** Opaque. The runtime never interprets it; it stores it verbatim. */
  nextCursor: string | null
  hasMore: boolean
}

export interface ConnectorHealth {
  status: 'ok' | 'degraded' | 'down'
  detail?: string
  checkedAt: string
}

export interface Connector<TPull = unknown, TPush = unknown> {
  describe(): ConnectorDescriptor
  health(): Promise<ConnectorResult<ConnectorHealth>>
  pull?(cursor: string | null): Promise<ConnectorResult<PullPage<TPull>>>
  push?(batch: TPush[], context: PushContext): Promise<ConnectorResult<{ delivered: number }>>
}

// ---------------------------------------------------------------------------
// Outbox store
// ---------------------------------------------------------------------------

/**
 * Mirrors the `status` check constraint on `public.synapse_domain_events`,
 * which is `('pending','published','failed','dead')`. Reusing that vocabulary
 * rather than inventing a parallel one keeps the runtime and the table
 * describing the same states.
 */
export type OutboxMessageStatus = 'pending' | 'published' | 'failed' | 'dead'

export interface OutboxMessage<TPush = unknown> {
  id: string
  tenantId: string
  connectorId: string
  /** Stable across retries; this is what the connector de-duplicates on. */
  idempotencyKey: string
  payload: TPush
  attempts: number
}

export interface OutboxClaim<TPush = unknown> {
  message: OutboxMessage<TPush>
  attempt: number
}

/**
 * The store owns durability. The runtime owns policy. Splitting them this way
 * means the policy can be exercised against an in-memory store in tests and
 * against a table in production without changing a line of the policy.
 */
export interface OutboxStore<TPush = unknown> {
  /**
   * Claim up to `limit` messages that are due for `connectorId` and not yet
   * delivered or dead. A claim must prevent another worker taking the same row.
   */
  claim(connectorId: string, limit: number, now: Date): Promise<Array<OutboxClaim<TPush>>>
  markDelivered(id: string, now: Date): Promise<void>
  /** `retryAt` null means dead-letter now. */
  markFailed(id: string, now: Date, error: string, retryAt: Date | null): Promise<void>
  /** Persist a new pull cursor for a connector. */
  saveCursor?(connectorId: string, cursor: string, now: Date): Promise<void>
}
