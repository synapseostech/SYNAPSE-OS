/**
 * Retry policy.
 *
 * Retries exist because the failures that matter in health interoperability are
 * mostly transient: a Tally server restarts, a DHIS2 instance rate-limits, a
 * link drops mid-push. The danger in the other direction is a retry loop that
 * either hammers a struggling peer or never gives up and hides a permanent
 * failure behind an ever-growing delay. So: exponential, capped, jittered, and
 * with a hard attempt ceiling after which the message is dead-lettered and
 * visible rather than silently retried forever.
 *
 * Pure functions and an injected clock — no timers, no sleeps, no I/O.
 */

import type { ConnectorFailure } from "./contract"

export interface RetryPolicy {
  /** Delay before the second attempt. */
  baseDelayMs: number
  /** Ceiling for a single delay, regardless of attempt count. */
  maxDelayMs: number
  /** Fraction of the delay that may be shaved off or added, 0–1. */
  jitterRatio: number
  /** Attempts (including the first) before dead-lettering. */
  maxAttempts: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60 * 1_000,
  jitterRatio: 0.2,
  maxAttempts: 8,
}

/**
 * Failure codes that are worth another attempt. Used only by connectors that
 * wrap a thrown error into a failure and want a default; the contract itself
 * makes `retryable` explicit.
 */
const RETRYABLE_CODES = new Set([
  "TIMEOUT",
  "RATE_LIMITED",
  "SERVER_ERROR",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "NETWORK",
  "CONNECTION_RESET",
  "LOCK_TIMEOUT",
  "CONNECTOR_THREW",
  "UPSTREAM_UNAVAILABLE",
])

/**
 * Infer whether a bare error code is worth retrying. Unknown codes are treated
 * as retryable: losing a message is worse than delivering it twice, and the
 * attempt ceiling bounds the cost of being wrong in that direction.
 */
export function inferRetryable(code: string): boolean {
  if (RETRYABLE_CODES.has(code)) return true
  if (code === "VALIDATION" || code === "AUTH" || code === "FORBIDDEN") return false
  if (code === "NOT_FOUND" || code === "REJECTED" || code === "SCHEMA_MISMATCH") return false
  return true
}

/** Whether a connector-reported failure should be retried. */
export function shouldRetry(failure: ConnectorFailure): boolean {
  return failure.retryable !== false
}

/**
 * Delay after the failure of `attempt` (1-based). The first failure waits
 * `baseDelayMs`, and each subsequent failure doubles it up to `maxDelayMs`.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1
  const exponent = Math.min(safeAttempt - 1, 30) // 2^30 already exceeds any sane cap
  const uncapped = policy.baseDelayMs * 2 ** exponent
  const capped = Math.min(uncapped, policy.maxDelayMs)
  const ratio = Math.min(Math.max(policy.jitterRatio, 0), 1)
  if (ratio === 0) return Math.max(0, Math.round(capped))
  // `random()` in [0,1) maps to [1-ratio, 1+ratio).
  const factor = 1 - ratio + random() * ratio * 2
  return Math.max(0, Math.round(capped * factor))
}

/** Whether a message's `retry_at` has arrived. A missing time means "now". */
export function isDue(retryAt: string | null | undefined, now: Date): boolean {
  if (!retryAt) return true
  const when = Date.parse(retryAt)
  if (Number.isNaN(when)) return true // unparseable means stuck; prefer progress
  return when <= now.getTime()
}
