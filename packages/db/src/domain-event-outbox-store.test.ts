import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { createDurableOutboxStore, type DueEventRow, type EventDeliveryClient } from "./domain-event-outbox-store"

const TENANT = "11111111-1111-4111-8111-111111111111"
const T0 = new Date("2026-10-25T09:00:00.000Z")

function row(id: string, retryCount = 0): DueEventRow {
  return {
    event_id: id,
    tenant_id: TENANT,
    idempotency_key: `k-${id}`,
    payload: { event_type: "PrescriptionCreated" },
    retry_count: retryCount,
  }
}

/** A client that records calls and returns whatever the test says. */
function fakeClient(overrides: Partial<EventDeliveryClient> = {}) {
  const calls: Array<{ method: string; input: unknown }> = []
  const client: EventDeliveryClient = {
    async listDue(input) {
      calls.push({ method: "listDue", input })
      return { rows: [], error: null }
    },
    async lease(input) {
      calls.push({ method: "lease", input })
      return { error: null }
    },
    async markPublished(input) {
      calls.push({ method: "markPublished", input })
      return { error: null }
    },
    async markFailed(input) {
      calls.push({ method: "markFailed", input })
      return { error: null }
    },
    ...overrides,
  }
  return { client, calls, find: (method: string) => calls.filter((call) => call.method === method) }
}

describe("createDurableOutboxStore", () => {
  it("reports the attempt about to be made, derived from the failure count", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [row("e1", 0), row("e2", 3)], error: null }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    const claims = await store.claim("tally-kla", 10, T0)

    assert.equal(claims.length, 2)
    assert.equal(claims[0]?.attempt, 1)
    assert.equal(claims[1]?.attempt, 4)
    assert.equal(claims[0]?.message.attempts, 0)
    assert.equal(claims[0]?.message.connectorId, "tally-kla")
    assert.equal(claims[0]?.message.idempotencyKey, "k-e1")
  })

  it("leases exactly the rows it hands out, for the configured window", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [row("e1"), row("e2")], error: null }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT, leaseMs: 45_000 })

    await store.claim("tally-kla", 10, T0)

    const [lease] = fake.find("lease")
    assert.deepEqual(lease?.input, {
      ids: ["e1", "e2"],
      until: new Date(T0.getTime() + 45_000),
    })
  })

  it("does not lease when nothing is due", async () => {
    const fake = fakeClient()
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    const claims = await store.claim("tally-kla", 10, T0)

    assert.deepEqual(claims, [])
    assert.equal(fake.find("lease").length, 0)
  })

  it("drops rows belonging to another tenant even if the client returns them", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [{ ...row("e1"), tenant_id: "someone-else" }], error: null }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    assert.deepEqual(await store.claim("tally-kla", 10, T0), [])
  })

  it("scopes the read to its own tenant and the caller's clock", async () => {
    const fake = fakeClient()
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await store.claim("tally-kla", 25, T0)

    const [list] = fake.find("listDue")
    assert.deepEqual(list?.input, { tenantId: TENANT, limit: 25, now: T0 })
    assert.equal(store.tenantId, TENANT)
  })

  it("stores an absolute retry count, because PostgREST cannot increment", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [row("e1", 4)], error: null }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })
    const retryAt = new Date(T0.getTime() + 8_000)

    await store.claim("tally-kla", 10, T0)
    await store.markFailed("e1", T0, "TIMEOUT: slow", retryAt)

    const [failed] = fake.find("markFailed")
    assert.deepEqual(failed?.input, {
      id: "e1",
      now: T0,
      error: "TIMEOUT: slow",
      nextAttemptAt: retryAt,
      retryCount: 5,
    })
  })

  it("counts a failure as the first attempt when the row was never leased here", async () => {
    const fake = fakeClient()
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await store.markFailed("e9", T0, "VALIDATION: bad", null)

    const [failed] = fake.find("markFailed")
    assert.equal((failed?.input as { retryCount: number }).retryCount, 1)
    assert.equal((failed?.input as { nextAttemptAt: Date | null }).nextAttemptAt, null)
  })

  it("does not carry a stale count into a second failure of the same event", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [row("e1", 1)], error: null }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await store.claim("tally-kla", 10, T0)
    await store.markFailed("e1", T0, "TIMEOUT: slow", new Date(T0.getTime() + 1_000))
    // A later run leases the same row again with an updated count.
    await store.claim("tally-kla", 10, T0)
    await store.markFailed("e1", T0, "TIMEOUT: slow", new Date(T0.getTime() + 2_000))

    const counts = fake.find("markFailed").map((call) => (call.input as { retryCount: number }).retryCount)
    assert.deepEqual(counts, [2, 2])
  })

  it("marks delivered through markPublished and forgets the lease", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [row("e1", 2)], error: null }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await store.claim("tally-kla", 10, T0)
    await store.markDelivered("e1", T0)

    const [published] = fake.find("markPublished")
    assert.deepEqual(published?.input, { id: "e1", now: T0 })
  })

  it("surfaces a read failure instead of reporting an empty queue", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [], error: "connection reset" }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await assert.rejects(() => store.claim("tally-kla", 10, T0), /OUTBOX_LIST_DUE_FAILED: connection reset/)
  })

  it("surfaces a lease failure rather than delivering unleased rows", async () => {
    const fake = fakeClient({
      async listDue() {
        return { rows: [row("e1")], error: null }
      },
      async lease() {
        return { error: "deadlock detected" }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await assert.rejects(() => store.claim("tally-kla", 10, T0), /OUTBOX_LEASE_FAILED: deadlock detected/)
  })

  it("surfaces a write failure so the relay can keep the message queued", async () => {
    const fake = fakeClient({
      async markPublished() {
        return { error: "write conflict" }
      },
      async markFailed() {
        return { error: "write conflict" }
      },
    })
    const store = createDurableOutboxStore(fake.client, { tenantId: TENANT })

    await assert.rejects(() => store.markDelivered("e1", T0), /OUTBOX_MARK_PUBLISHED_FAILED/)
    await assert.rejects(() => store.markFailed("e1", T0, "x", null), /OUTBOX_MARK_FAILED_FAILED/)
  })
})
