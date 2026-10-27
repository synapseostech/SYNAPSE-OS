import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { OutboxRecord } from "@synapse/interop"

import { persistDomainEventsBestEffort, type DbClient } from "./work-queue-persist"

const TENANT = "11111111-1111-4111-8111-111111111111"

function event(idempotencyKey = "PrescriptionCreated:t:agg:create"): OutboxRecord {
  return {
    event_id: "22222222-2222-4222-8222-222222222222",
    event_type: "PrescriptionCreated",
    version: "1.0.0",
    tenant_id: TENANT,
    facility_id: null,
    actor_id: null,
    patient_id: null,
    person_id: null,
    encounter_id: null,
    timestamp: "2026-10-25T09:00:00.000Z",
    correlation_id: "33333333-3333-4333-8333-333333333333",
    causation_id: null,
    payload: { medication: "Amoxicillin" },
    source: "synapse-os",
    idempotency_key: idempotencyKey,
    is_synthetic: false,
    simulation_run_id: null,
    status: "pending",
    retry_count: 0,
    last_error: null,
    published_at: null,
  }
}

function fakeDb(result: { error: { message?: string } | null } = { error: null }) {
  const calls: Array<{ table: string; rows: unknown; options: unknown }> = []
  const db: DbClient = {
    from(table: string) {
      return {
        upsert(rows, options) {
          calls.push({ table, rows, options })
          return Promise.resolve(result) as PromiseLike<{ error: { message?: string } | null }>
        },
      }
    },
  }
  return { db, calls }
}

describe("persistDomainEventsBestEffort", () => {
  it("ignores duplicates so a replay cannot reset a published row", async () => {
    const { db, calls } = fakeDb()

    await persistDomainEventsBestEffort(db, [event()])

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.table, "synapse_domain_events")
    assert.deepEqual(calls[0]?.options, { onConflict: "idempotency_key", ignoreDuplicates: true })
  })

  it("reports how many events were offered to the table", async () => {
    const { db } = fakeDb()

    const result = await persistDomainEventsBestEffort(db, [event("a"), event("b")])

    assert.deepEqual(result, { ok: true, inserted: 2 })
  })

  it("does not touch the table when there is nothing to emit", async () => {
    const { db, calls } = fakeDb()

    const result = await persistDomainEventsBestEffort(db, [])

    assert.deepEqual(result, { ok: true, inserted: 0 })
    assert.equal(calls.length, 0)
  })

  it("reports a database error without throwing", async () => {
    const { db } = fakeDb({ error: { message: "permission denied for table synapse_domain_events" } })

    const result = await persistDomainEventsBestEffort(db, [event()])

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /permission denied/)
    assert.equal(result.inserted, 0)
  })

  it("still treats a duplicate-key complaint as soft success", async () => {
    const { db } = fakeDb({ error: { message: "duplicate key value violates unique constraint" } })

    const result = await persistDomainEventsBestEffort(db, [event()])

    assert.deepEqual(result, { ok: true, inserted: 0 })
  })

  it("never writes delivery state that the relay owns", async () => {
    const { db, calls } = fakeDb()

    await persistDomainEventsBestEffort(db, [event()])

    const rows = calls[0]?.rows as Array<Record<string, unknown>>
    // The emitter does include these keys — which is precisely why the upsert
    // must ignore duplicates. If that flag is ever dropped, an already published
    // event would be rewritten to `pending` and delivered again.
    assert.equal(rows[0]?.status, "pending")
    assert.equal(rows[0]?.retry_count, 0)
    assert.equal(rows[0]?.published_at, null)
    assert.equal((calls[0]?.options as { ignoreDuplicates?: boolean }).ignoreDuplicates, true)
  })
})
