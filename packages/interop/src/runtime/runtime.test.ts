import { describe, expect, it } from "vitest"

import { createSimulationAdapter } from "../adapters/simulation"
import type {
  Connector,
  ConnectorDescriptor,
  ConnectorResult,
  OutboxStore,
  PushContext,
} from "./contract"
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  inferRetryable,
  isDue,
  shouldRetry,
} from "./backoff"
import { createCircuitBreaker } from "./breaker"
import { createInMemoryOutboxStore, type SeedMessage } from "./memory-store"
import { pullConnector, relayAll, relayConnector, type RelayConnectorInput } from "./relay"
import { resolveAdapter, resolveAdapters, type AdapterRow } from "./connector-config"
import { wrapSynapseAdapter, type OutboundEnvelope } from "./synapse-bridge"

const T0 = new Date("2026-10-25T09:00:00.000Z")
const at = (ms: number) => new Date(T0.getTime() + ms)

// A connector whose push behaviour the test controls.
function fakeConnector(
  id: string,
  push: (payload: unknown, context: PushContext) => Promise<ConnectorResult<{ delivered: number }>>,
  options: Partial<ConnectorDescriptor> & { pull?: Connector["pull"] } = {},
): Connector<unknown, unknown> {
  const { pull, ...descriptorOverrides } = options
  const descriptor: ConnectorDescriptor = {
    id,
    tenantId: "11111111-1111-4111-8111-111111111111",
    kind: "tally",
    displayName: id,
    capabilities: ["health", "push"],
    ...descriptorOverrides,
  }
  return {
    describe: () => descriptor,
    async health() {
      return {
        ok: true as const,
        data: { status: "ok" as const, checkedAt: T0.toISOString() },
      }
    },
    pull,
    push,
  }
}

function seed(id: string, payload: unknown = { id }, connectorId = "tally-1"): SeedMessage<unknown> {
  return {
    id,
    tenantId: "11111111-1111-4111-8111-111111111111",
    connectorId,
    idempotencyKey: `k-${id}`,
    payload,
  }
}

function relayInput(
  connector: Connector<unknown, unknown>,
  store: OutboxStore<unknown>,
  overrides: Partial<RelayConnectorInput<unknown>> = {},
): RelayConnectorInput<unknown> {
  return { connector, store, now: T0, random: () => 0.5, ...overrides }
}

describe("backoff", () => {
  it("waits the base delay after the first failure and doubles from there", () => {
    expect(backoffDelayMs(1, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1_000)
    expect(backoffDelayMs(2, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(2_000)
    expect(backoffDelayMs(3, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(4_000)
    expect(backoffDelayMs(4, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(8_000)
  })

  it("caps the delay no matter how many attempts have failed", () => {
    expect(backoffDelayMs(40, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs)
    expect(backoffDelayMs(1_000, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs)
  })

  it("keeps jitter inside its band, so a retry is never negative or unbounded", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitterRatio: 0.2 }
    const low = backoffDelayMs(3, policy, () => 0)
    const high = backoffDelayMs(3, policy, () => 0.999)
    expect(low).toBe(3_200) // 4000 * 0.8
    expect(high).toBeLessThanOrEqual(4_800)
    expect(high).toBeGreaterThanOrEqual(4_700)
    expect(backoffDelayMs(3, { ...policy, jitterRatio: 0 }, () => 0.999)).toBe(4_000)
  })

  it("treats a nonsensical attempt number as the first failure", () => {
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1_000)
    expect(backoffDelayMs(-5, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1_000)
    expect(backoffDelayMs(Number.NaN, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1_000)
  })

  it("retries unknown codes but not validation or auth failures", () => {
    expect(inferRetryable("TIMEOUT")).toBe(true)
    expect(inferRetryable("RATE_LIMITED")).toBe(true)
    expect(inferRetryable("SOMETHING_NEW")).toBe(true)
    expect(inferRetryable("VALIDATION")).toBe(false)
    expect(inferRetryable("AUTH")).toBe(false)
    expect(inferRetryable("NOT_FOUND")).toBe(false)
  })

  it("honours an explicit retryable flag over the code", () => {
    expect(shouldRetry({ ok: false, code: "VALIDATION", message: "", retryable: true })).toBe(true)
    expect(shouldRetry({ ok: false, code: "TIMEOUT", message: "", retryable: false })).toBe(false)
  })

  it("treats a missing or unparseable retry time as due, and a future one as not due", () => {
    expect(isDue(null, T0)).toBe(true)
    expect(isDue(undefined, T0)).toBe(true)
    expect(isDue("not a date", T0)).toBe(true)
    expect(isDue(T0.toISOString(), T0)).toBe(true)
    expect(isDue(at(1).toISOString(), T0)).toBe(false)
  })
})

describe("circuit breaker", () => {
  it("stays closed until the failure threshold is reached", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 })
    expect(breaker.canAttempt("c", T0)).toBe(true)
    breaker.recordFailure("c", T0)
    breaker.recordFailure("c", T0)
    expect(breaker.state("c", T0)).toBe("closed")
    breaker.recordFailure("c", T0)
    expect(breaker.state("c", T0)).toBe("open")
    expect(breaker.canAttempt("c", T0)).toBe(false)
  })

  it("grants exactly one trial after the cooldown, then closes on success", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 })
    breaker.recordFailure("c", T0)
    expect(breaker.canAttempt("c", at(30_000))).toBe(false)
    expect(breaker.state("c", at(60_000))).toBe("half_open")
    expect(breaker.canAttempt("c", at(60_000))).toBe(true)
    expect(breaker.canAttempt("c", at(60_000))).toBe(false) // trial already in flight
    breaker.recordSuccess("c")
    expect(breaker.state("c", at(60_000))).toBe("closed")
  })

  it("reopens for a full cooldown when the trial fails", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 })
    breaker.recordFailure("c", T0)
    expect(breaker.canAttempt("c", at(60_000))).toBe(true)
    breaker.recordFailure("c", at(60_000))
    expect(breaker.state("c", at(60_000))).toBe("open")
    expect(breaker.canAttempt("c", at(90_000))).toBe(false)
    expect(breaker.canAttempt("c", at(120_000))).toBe(true)
  })

  it("isolates one connector's outage from the others", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 })
    breaker.recordFailure("tally", T0)
    expect(breaker.state("tally", T0)).toBe("open")
    expect(breaker.state("dhis2", T0)).toBe("closed")
    expect(breaker.canAttempt("dhis2", T0)).toBe(true)
  })
})

describe("relayConnector", () => {
  it("publishes a message only after the connector reports success", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const seen: PushContext[] = []
    const connector = fakeConnector("tally-1", async (_payload, context) => {
      seen.push(context)
      expect(store.rows()[0]?.status).toBe("pending") // not yet marked
      return { ok: true, data: { delivered: 1 } }
    })

    const summary = await relayConnector(relayInput(connector, store))

    expect(summary.published).toBe(1)
    expect(summary.retried).toBe(0)
    expect(summary.dead).toBe(0)
    expect(store.rows()[0]?.status).toBe("published")
    expect(store.rows()[0]?.publishedAt?.getTime()).toBe(T0.getTime())
    expect(seen[0]?.idempotencyKey).toBe("k-m1")
    expect(seen[0]?.attempt).toBe(1)
  })

  it("keeps the idempotency key stable across retries", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const keys: string[] = []
    const connector = fakeConnector("tally-1", async (_payload, context) => {
      keys.push(context.idempotencyKey)
      return { ok: false, code: "TIMEOUT", message: "gone", retryable: true }
    })

    await relayConnector(relayInput(connector, store, { now: T0 }))
    const retryAt = store.rows()[0]?.retryAt
    expect(retryAt).not.toBeNull()
    await relayConnector(relayInput(connector, store, { now: retryAt as Date }))

    expect(keys).toEqual(["k-m1", "k-m1"])
    expect(store.rows()[0]?.attempts).toBe(2)
  })

  it("schedules a retry with backoff instead of failing the message", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const connector = fakeConnector("tally-1", async () => ({
      ok: false,
      code: "SERVER_ERROR",
      message: "500",
      retryable: true,
    }))

    const summary = await relayConnector(relayInput(connector, store))

    expect(summary.retried).toBe(1)
    expect(summary.dead).toBe(0)
    expect(store.rows()[0]?.status).toBe("failed")
    expect(store.rows()[0]?.lastError).toBe("SERVER_ERROR: 500")
    expect(store.rows()[0]?.retryAt?.getTime()).toBe(T0.getTime() + 1_000)
  })

  it("dead-letters a non-retryable failure immediately", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const connector = fakeConnector("tally-1", async () => ({
      ok: false,
      code: "VALIDATION",
      message: "bad voucher",
      retryable: false,
    }))

    const summary = await relayConnector(relayInput(connector, store))

    expect(summary.dead).toBe(1)
    expect(summary.retried).toBe(0)
    expect(store.rows()[0]?.status).toBe("dead")
    expect(store.rows()[0]?.retryAt).toBeNull()
  })

  it("dead-letters once the attempt ceiling is reached", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const connector = fakeConnector(
      "tally-1",
      async () => ({ ok: false, code: "TIMEOUT", message: "slow", retryable: true }),
      { maxAttempts: 2 },
    )

    await relayConnector(relayInput(connector, store, { now: T0 }))
    expect(store.rows()[0]?.status).toBe("failed")

    await relayConnector(relayInput(connector, store, { now: at(1_000) }))
    expect(store.rows()[0]?.status).toBe("dead")
    expect(store.rows()[0]?.attempts).toBe(2)
  })

  it("turns a connector exception into a retryable failure rather than crashing", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const connector = fakeConnector("tally-1", async () => {
      throw new Error("socket hang up")
    })

    const summary = await relayConnector(relayInput(connector, store))

    expect(summary.retried).toBe(1)
    expect(store.rows()[0]?.lastError).toBe("CONNECTOR_THREW: socket hang up")
  })

  it("stops mid-batch when the circuit opens, leaving the remainder pending", async () => {
    const store = createInMemoryOutboxStore([
      seed("m1"),
      seed("m2"),
      seed("m3"),
      seed("m4"),
    ])
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 })
    const connector = fakeConnector("tally-1", async () => ({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      message: "down",
      retryable: true,
    }))

    const summary = await relayConnector(
      relayInput(connector, store, { breaker, policy: { batchSize: 10, retry: DEFAULT_RETRY_POLICY } }),
    )

    expect(summary.claimed).toBe(4)
    expect(summary.retried).toBe(2)
    expect(summary.skipped).toBe(2)
    expect(summary.skipReason).toBe("circuit_open")
    expect(store.rows()[2]?.status).toBe("pending")
    expect(store.rows()[3]?.attempts).toBe(0)
  })

  it("claims nothing while the circuit is open", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 })
    breaker.recordFailure("tally-1", T0)
    let called = false
    const connector = fakeConnector("tally-1", async () => {
      called = true
      return { ok: true, data: { delivered: 1 } }
    })

    const summary = await relayConnector(relayInput(connector, store, { breaker }))

    expect(called).toBe(false)
    expect(summary.claimed).toBe(0)
    expect(summary.skipReason).toBe("circuit_open")
    expect(store.rows()[0]?.attempts).toBe(0)
  })

  it("does not count a validation failure against the circuit", async () => {
    const store = createInMemoryOutboxStore([seed("m1"), seed("m2")])
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 })
    const connector = fakeConnector("tally-1", async () => ({
      ok: false,
      code: "VALIDATION",
      message: "bad",
      retryable: false,
    }))

    const summary = await relayConnector(relayInput(connector, store, { breaker }))

    expect(summary.dead).toBe(2)
    expect(breaker.state("tally-1", T0)).toBe("closed")
  })

  it("reports an error instead of claiming success when the row cannot be marked", async () => {
    const inner = createInMemoryOutboxStore([seed("m1")])
    const store: OutboxStore<unknown> = {
      ...inner,
      claim: inner.claim,
      async markDelivered() {
        throw new Error("write conflict")
      },
      markFailed: inner.markFailed,
    }
    const connector = fakeConnector("tally-1", async () => ({ ok: true, data: { delivered: 1 } }))

    const summary = await relayConnector(relayInput(connector, store))

    expect(summary.published).toBe(0)
    expect(summary.errors[0]).toContain("mark_published_failed: write conflict")
    expect(inner.rows()[0]?.status).toBe("pending") // stays queued for replay
  })

  it("skips a connector that cannot push", async () => {
    const store = createInMemoryOutboxStore([seed("m1")])
    const connector = fakeConnector("tally-1", async () => ({ ok: true, data: { delivered: 1 } }), {
      capabilities: ["health", "pull"],
    })

    const summary = await relayConnector(relayInput(connector, store))

    expect(summary.skipReason).toBe("no_push_capability")
    expect(summary.claimed).toBe(0)
  })

  it("leaves another connector untouched when one of them fails", async () => {
    const store = createInMemoryOutboxStore([seed("m1", {}, "tally-1"), seed("m2", {}, "dhis2")])
    const tally = fakeConnector("tally-1", async () => ({ ok: true, data: { delivered: 1 } }))
    const dhis2 = fakeConnector(
      "dhis2",
      async () => ({ ok: false, code: "VALIDATION", message: "no", retryable: false }),
      { kind: "dhis2" },
    )

    const summaries = await relayAll({
      connections: [
        { connector: tally, store, now: T0 },
        { connector: dhis2, store, now: T0 },
      ],
      random: () => 0.5,
    })

    expect(summaries.map((row) => row.published)).toEqual([1, 0])
    expect(summaries.map((row) => row.dead)).toEqual([0, 1])
    expect(store.rows().map((row) => row.status)).toEqual(["published", "dead"])
  })
})

describe("pullConnector", () => {
  const page = <T,>(items: T[], nextCursor: string | null, hasMore: boolean) =>
    ({ ok: true as const, data: { items, nextCursor, hasMore } })

  it("advances and persists the cursor page by page", async () => {
    const store = createInMemoryOutboxStore()
    const cursors: Array<string | null> = []
    const connector = fakeConnector(
      "tally-1",
      async () => ({ ok: true, data: { delivered: 0 } }),
      {
        capabilities: ["pull"],
        pull: async (cursor) => {
          cursors.push(cursor)
          if (cursor === null) return page([1, 2], "c1", true)
          if (cursor === "c1") return page([3], "c2", true)
          return page([4], "c3", false)
        },
      },
    )

    const summary = await pullConnector({ connector, store, cursor: null, now: T0 })

    expect(summary.items).toBe(4)
    expect(summary.pages).toBe(3)
    expect(summary.cursor).toBe("c3")
    expect(summary.stoppedBecause).toBe("exhausted")
    expect(cursors).toEqual([null, "c1", "c2"])
    expect(store.cursors()["tally-1"]).toBe("c3")
  })

  it("does not advance the cursor when a pull fails", async () => {
    const store = createInMemoryOutboxStore()
    const connector = fakeConnector(
      "tally-1",
      async () => ({ ok: true, data: { delivered: 0 } }),
      {
        capabilities: ["pull"],
        pull: async () => ({ ok: false, code: "TIMEOUT", message: "slow", retryable: true }),
      },
    )

    const summary = await pullConnector({ connector, store, cursor: "c1", now: T0 })

    expect(summary.stoppedBecause).toBe("failed")
    expect(summary.cursor).toBe("c1")
    expect(store.cursors()["tally-1"]).toBeUndefined()
    expect(summary.errors[0]).toContain("TIMEOUT")
  })

  it("treats hasMore without a cursor as a stall rather than looping", async () => {
    const connector = fakeConnector(
      "tally-1",
      async () => ({ ok: true, data: { delivered: 0 } }),
      {
        capabilities: ["pull"],
        pull: async () => page([1], null, true),
      },
    )

    const summary = await pullConnector({
      connector,
      store: createInMemoryOutboxStore(),
      cursor: null,
      now: T0,
    })

    expect(summary.stoppedBecause).toBe("cursor_stalled")
    expect(summary.pages).toBe(1)
  })

  it("stops at the page limit with the cursor it has already saved", async () => {
    const store = createInMemoryOutboxStore()
    let counter = 0
    const connector = fakeConnector(
      "tally-1",
      async () => ({ ok: true, data: { delivered: 0 } }),
      {
        capabilities: ["pull"],
        pull: async () => {
          counter += 1
          return page([counter], `c${counter}`, true)
        },
      },
    )

    const summary = await pullConnector({ connector, store, cursor: null, now: T0, maxPages: 3 })

    expect(summary.stoppedBecause).toBe("page_limit")
    expect(summary.pages).toBe(3)
    expect(store.cursors()["tally-1"]).toBe("c3")
  })

  it("refuses to pull from a connector that does not declare it", async () => {
    const connector = fakeConnector("tally-1", async () => ({ ok: true, data: { delivered: 0 } }))
    const summary = await pullConnector({
      connector,
      store: createInMemoryOutboxStore(),
      cursor: null,
      now: T0,
    })
    expect(summary.stoppedBecause).toBe("no_pull_capability")
  })
})

describe("resolveAdapter", () => {
  const row = (overrides: Partial<AdapterRow> = {}): AdapterRow => ({
    id: "tally-kla",
    name: "Kampala Tally",
    system: "TallyPrime",
    mode: "overlay",
    simulation: false,
    version: "1.0.0",
    status: "live",
    ...overrides,
  })

  it("resolves a live adapter, pairing the row with the caller's tenant", () => {
    const resolved = resolveAdapter(row(), "tenant-abc")
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.live).toBe(true)
    expect(resolved.descriptor.id).toBe("tally-kla")
    expect(resolved.descriptor.kind).toBe("tally")
    expect(resolved.descriptor.tenantId).toBe("tenant-abc")
  })

  it("moves no data by default, because the row declares no capability", () => {
    const resolved = resolveAdapter(row(), "tenant-abc")
    expect(resolved.ok && resolved.descriptor.capabilities).toEqual(["health"])
  })

  it("is not live unless both simulation and status independently say so", () => {
    const halfFlipped = resolveAdapter(row({ simulation: true, status: "live" }), "tenant-abc")
    const halfNamed = resolveAdapter(row({ simulation: false, status: "simulation" }), "tenant-abc")
    expect(halfFlipped.ok && halfFlipped.live).toBe(false)
    expect(halfNamed.ok && halfNamed.live).toBe(false)
  })

  it("requires the tenant to be supplied, because the table has no tenant column", () => {
    const resolved = resolveAdapter(row(), "")
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.issues.map((issue) => issue.code)).toContain("ADAPTER_TENANT_REQUIRED")
  })

  it("rejects ids that could not be used safely as a log or meter label", () => {
    for (const id of ["ab", "Has Space", "UPPER", "bad/id", ""]) {
      const resolved = resolveAdapter(row({ id }), "tenant-abc")
      expect(resolved.ok).toBe(false)
      if (resolved.ok) continue
      expect(resolved.issues.map((issue) => issue.code)).toContain("ADAPTER_ID_INVALID")
    }
  })

  it("rejects an unknown system, mode or missing version", () => {
    const systems = resolveAdapter(row({ system: "Mystery Box" }), "t")
    const modes = resolveAdapter(row({ mode: "tunnel" }), "t")
    const versions = resolveAdapter(row({ version: "  " }), "t")
    expect(systems.ok === false && systems.issues[0]?.code).toBe("ADAPTER_SYSTEM_UNSUPPORTED")
    expect(modes.ok === false && modes.issues[0]?.code).toBe("ADAPTER_MODE_UNSUPPORTED")
    expect(versions.ok === false && versions.issues[0]?.code).toBe("ADAPTER_VERSION_MISSING")
  })

  it("separates usable rows from rejected ones without dropping the reason", () => {
    const result = resolveAdapters(
      [row(), row({ id: "dhis2-kla", system: "dhis2" }), row({ id: "x", system: "nope" })],
      "tenant-abc",
      (candidate) => (candidate.id.startsWith("dhis2") ? ["health", "push"] : ["health"]),
    )
    expect(result.descriptors).toHaveLength(2)
    expect(result.descriptors[1]?.capabilities).toEqual(["health", "push"])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.id).toBe("x")
  })
})

describe("wrapSynapseAdapter", () => {
  it("refuses to send real data through a simulated adapter", async () => {
    const connector = wrapSynapseAdapter(createSimulationAdapter("dhis2"), { tenantId: "t1" })
    const result = await connector.push?.(
      [{ kind: "patient", resource: { id: "p1" } }],
      { idempotencyKey: "k1", attempt: 1 },
    )
    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.code).toBe("SIMULATION_ADAPTER_REFUSED_REAL_DATA")
    expect(result.retryable).toBe(false)
  })

  it("allows explicitly synthetic data through a simulated adapter", async () => {
    const connector = wrapSynapseAdapter(createSimulationAdapter("dhis2"), { tenantId: "t1" })
    const result = await connector.push?.(
      [{ kind: "patient", resource: { id: "p1" }, synthetic: true }],
      { idempotencyKey: "k1", attempt: 1 },
    )
    expect(result).toEqual({ ok: true, data: { delivered: 1 } })
  })

  it("reports a simulated peer as degraded, never as healthy", async () => {
    const connector = wrapSynapseAdapter(createSimulationAdapter("ugandaemr"), {
      tenantId: "t1",
      clock: () => T0,
    })
    const health = await connector.health()
    expect(health.ok).toBe(true)
    if (!health.ok) return
    expect(health.data.status).toBe("degraded")
    expect(health.data.detail).toContain("simulation")
    expect(health.data.checkedAt).toBe(T0.toISOString())
  })

  it("marks a timeout retryable and an invalid code terminal", async () => {
    const timedOut = wrapSynapseAdapter(createSimulationAdapter("dhis2", "timeout"), { tenantId: "t1" })
    const invalid = wrapSynapseAdapter(createSimulationAdapter("dhis2", "invalid_code"), { tenantId: "t1" })
    const envelope: OutboundEnvelope[] = [{ kind: "patient", resource: { id: "p1" }, synthetic: true }]
    const context = { idempotencyKey: "k1", attempt: 1 }

    const timeout = await timedOut.push?.(envelope, context)
    const coded = await invalid.push?.(envelope, context)

    expect(timeout?.ok === false && timeout.retryable).toBe(true)
    expect(coded?.ok === false && coded.retryable).toBe(false)
  })

  it("pulls a full page and reports no cursor, because the SDK has none", async () => {
    const connector = wrapSynapseAdapter(createSimulationAdapter("ugandaemr"), { tenantId: "t1" })
    const pulled = await connector.pull?.(null)
    expect(pulled?.ok).toBe(true)
    if (!pulled || !pulled.ok) return
    expect(pulled.data.items).toHaveLength(1)
    expect(pulled.data.nextCursor).toBeNull()
    expect(pulled.data.hasMore).toBe(false)
  })

  it("derives the connector kind from the adapter identity", () => {
    const tally = wrapSynapseAdapter(createSimulationAdapter("dhis2"), { tenantId: "t1" })
    const openmrs = wrapSynapseAdapter(createSimulationAdapter("openmrs"), { tenantId: "t1" })
    expect(tally.describe().kind).toBe("dhis2")
    expect(openmrs.describe().kind).toBe("openmrs")
  })
})
