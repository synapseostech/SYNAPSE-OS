/**
 * Per-connector circuit breaker.
 *
 * When a downstream system is down, retrying every queued message against it
 * makes the outage worse and buries the one signal an operator needs — that the
 * peer is unreachable. The breaker stops attempting after a run of failures,
 * leaves messages queued (not failed, not dead), and reopens a single trial
 * after a cooldown.
 *
 * Scoped per connector id, because one dead peer must not stop delivery to the
 * others.
 */

export interface BreakerPolicy {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number
  /** How long the circuit stays open before one trial is allowed. */
  cooldownMs: number
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 60_000,
}

export type BreakerState = "closed" | "open" | "half_open"

interface BreakerEntry {
  state: BreakerState
  failures: number
  openedAt: number | null
  trialInFlight: boolean
}

export interface CircuitBreaker {
  state(connectorId: string, now: Date): BreakerState
  /** True when an attempt may proceed. A half-open circuit grants one trial. */
  canAttempt(connectorId: string, now: Date): boolean
  recordSuccess(connectorId: string): void
  recordFailure(connectorId: string, now: Date): void
  /** Forget all state for a connector, e.g. after it is reconfigured. */
  reset(connectorId?: string): void
}

export function createCircuitBreaker(policy: BreakerPolicy = DEFAULT_BREAKER_POLICY): CircuitBreaker {
  const entries = new Map<string, BreakerEntry>()

  function entry(connectorId: string): BreakerEntry {
    const existing = entries.get(connectorId)
    if (existing) return existing
    const fresh: BreakerEntry = { state: "closed", failures: 0, openedAt: null, trialInFlight: false }
    entries.set(connectorId, fresh)
    return fresh
  }

  function refresh(connectorId: string, now: Date): BreakerEntry {
    const current = entry(connectorId)
    if (current.state === "open" && current.openedAt !== null) {
      if (now.getTime() - current.openedAt >= policy.cooldownMs) {
        current.state = "half_open"
        current.trialInFlight = false
      }
    }
    return current
  }

  return {
    state(connectorId, now) {
      return refresh(connectorId, now).state
    },
    canAttempt(connectorId, now) {
      const current = refresh(connectorId, now)
      if (current.state === "closed") return true
      if (current.state === "half_open") {
        if (current.trialInFlight) return false
        current.trialInFlight = true
        return true
      }
      return false
    },
    recordSuccess(connectorId) {
      entries.set(connectorId, { state: "closed", failures: 0, openedAt: null, trialInFlight: false })
    },
    recordFailure(connectorId, now) {
      const current = entry(connectorId)
      current.trialInFlight = false
      current.failures += 1
      // A failed half-open trial reopens immediately for a full cooldown; the
      // peer has just proved it is still not ready.
      if (current.state === "half_open" || current.failures >= policy.failureThreshold) {
        current.state = "open"
        current.openedAt = now.getTime()
      }
    },
    reset(connectorId) {
      if (connectorId === undefined) entries.clear()
      else entries.delete(connectorId)
    },
  }
}
