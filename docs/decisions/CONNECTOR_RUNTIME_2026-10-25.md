# Connector runtime

**Date:** 2026-10-25
**Scope:** `packages/interop/src/runtime/`, `packages/db/src/domain-event-outbox-store.ts`, `packages/db/src/supabase-event-delivery.ts`, `packages/db/src/tally-xml.ts`, `supabase/migrations/20261026180000_domain_event_outbox_dispatch.sql`
**Status:** built and tested in the tree. Not applied, not deployed, not wired to a live connector.

---

## What was actually missing

`docs/architecture/INTEROP_BASELINE_2026-10-25.md` recorded the gap precisely: the canonical model, the adapter ladder and the export paths already existed, but no runtime did. Three concrete symptoms were true of the tree:

`synapse_adapters` is a schema with no rows and no code that reads it. `AdapterRegistry` in `packages/interop/src/adapters/sdk.ts` is an in-process `Map` — registering an adapter made it callable and nothing more.

`synapse_domain_events` is written by `persistDomainEventsBestEffort` from six API routes and read by one route. Nothing drained it. Every event ever emitted stayed `pending` forever.

`adapterFor()` rejected every `.xml` upload even though `MigrationFormat` declared `"tally-xml"`, so the one Tally format a Ugandan pharmacy actually exports could not be imported at all.

## What was built

The runtime is a policy layer over injected collaborators. It performs no I/O, reads no clock, and holds no state of its own, which is why every branch below is covered by a unit test rather than an argument.

`contract.ts` defines a `Connector` — `describe`, `health`, `pull(cursor)`, `push(batch, context)` — and an `OutboxStore` with `claim`, `markDelivered` and `markFailed`. The store owns durability; the runtime owns policy. `OutboxMessageStatus` deliberately reuses the `('pending','published','failed','dead')` vocabulary of the table's check constraint rather than inventing a parallel one.

`backoff.ts` is exponential, capped at fifteen minutes, jittered, with a hard attempt ceiling. Unknown failure codes are treated as retryable, because losing a message is worse than delivering it twice.

`breaker.ts` is a per-connector circuit breaker. One dead peer must not stop delivery to the others, and a validation rejection from a reachable peer must not count toward opening it.

`relay.ts` drains one connector's due messages, one message per `push` call so the idempotency key is unambiguous. A message leaves the queue in exactly one of three ways: published, dead-lettered with the error recorded, or still pending. A connector that throws becomes a recorded retryable failure, not a crashed relay. `pullConnector` advances its cursor only after a page is accepted, never on failure, and treats `hasMore` without a new cursor as a stall rather than looping.

`connector-config.ts` resolves `synapse_adapters` rows into descriptors. The table has no tenant column, so the tenant is supplied by the caller and pairing the two is explicit. The table records no direction, so capabilities are declared by the deployment and default to `health` only — an adapter row on its own moves nothing. An adapter is live only when `simulation = false` **and** `status = 'live'`; anything else, including `null`, is not live.

`synapse-bridge.ts` wraps the existing `SynapseAdapter` SDK as a `Connector`, using `createSimulationAdapter` for verification. It refuses, non-retryably, to send a non-synthetic record through a simulated adapter. Absent `synthetic` is treated as real, so the guard fails closed.

`domain-event-outbox-store.ts` implements `OutboxStore` over the real table, and `supabase-event-delivery.ts` adapts a real `SupabaseClient` to it — typed against supabase-js itself, not a hand-written lookalike.

## A defect found and fixed in the emitter

`persistDomainEventsBestEffort` upserted with `onConflict: "idempotency_key"` and wrote `status`, `retry_count`, `last_error` and `published_at` from the in-memory record. Those four columns are delivery state. A re-emitted idempotency key would therefore have reset an already-published event back to `pending`, and a working relay would have delivered it again — indefinitely, since emission is idempotent by design.

The fix is one option: `ignoreDuplicates: true`. A replay is now a no-op, and the table's own defaults (`'pending'`, `0`, `null`, `null`) describe every new event. `domain-event-emit.test.ts` pins the flag and asserts why it is load-bearing.

## Schema gap, prepared not applied

The table has no scheduling column and no lease column. Without them a relay either retries in a hot loop or two workers deliver the same event. `20261026180000_domain_event_outbox_dispatch.sql` adds `next_attempt_at` and `locked_until` and a partial dispatch index. It is additive and catalogue-only on PG11+, changes no row and no policy, and is **not applied**. Until it lands, the durable store must not be wired to a live relay.

## What is still not true

These are the things this work does not claim.

**No worker runs the relay.** The functions exist and are tested; nothing invokes them on a schedule. A cron route or a worker process is still needed, and a worker that is not running is indistinguishable from a healthy quiet queue unless someone alerts on `pending` age.

**The durable store is not wired anywhere.** It type-checks against the real client and is unit-tested against a fake, but it has never run against PostgreSQL. Its queries are unproven in the only sense that matters.

**One connector per tenant.** The table has no connector column, so a row is a domain event, not a delivery. Fan-out of one event to several connectors needs a delivery table and is not attempted. The pilot reality — a single Tally instance — is what this fits.

**Pull is not incremental.** The SDK's pull methods take a query, not a cursor. The bridge pulls one full page and reports `hasMore: false`. Incremental pull needs a modified-since parameter the canonical contract does not carry; inventing one would produce a cursor that silently skips records.

**`packages/db/src/types.ts` does not describe `synapse_domain_events`.** The generated types are stale relative to the schema, which is why the adapter leaves the generic open. Regenerating them is a prerequisite for typed access.

**No mapping or validation against a peer's schema.** `createAdapter` still contains `ADAPTER_STUB` branches. Credential handling is untouched: `credentialRef` is declared in `AdapterConfig` and read by nothing.

**`packages/interop` is not linted.** Only `apps/web` and `apps/pharmacy` define a `lint` script, so no `packages/*` workspace is linted at all. This is pre-existing and was not changed here.

**Superseded 2026-10-26.** `packages/interop` and `packages/db` now carry an `eslint.config.mjs` and a `lint` script each. The interop config enables `no-explicit-any`; the db config disables it at seven `as any` sites (identity-persist.ts 4, audit.ts 2, till-service.ts 1), so db's lint currently proves the package parses and little else. The other four packages remain unlinted.

**Evidence baseline.** `artifacts/readiness/evidence.json` records `migrationCount: 194` and a pinned HEAD of `c9e53e37`. That figure is correct *for that baseline*; three migrations have been prepared since. `scripts/evidence-drift.test.mjs` compares evidence.json to a constant, not to the directory, so it cannot detect this kind of drift. The closure documents were deliberately not rewritten — they describe a specific commit — but a reader comparing `db:check` output (197 files) with the closure evidence (194) should know why the numbers differ.

**Superseded 2026-10-26.** The drift test now reads `supabase/migrations` and compares the recorded figure to the directory, so this drift class is caught. `evidence.json` records 197. The suite-count constants remain pinned; only the migration count is derived.

## Prerequisites before this is called an integration

Apply the dispatch migration through the normal path. Regenerate `types.ts`. Build and schedule a runner, with an alert on the age of the oldest `pending` row. Create a delivery table if more than one connector per tenant is ever needed. Add a modified-since parameter to the canonical pull contract. Decide credential storage, and implement it rather than leaving `credentialRef` decorative. Then, and only then, connect a real Tally instance to a real tenant with a human watching the dead-letter count.

## Gates

`npm run test:interop-runtime` — 41 tests.
`npm run test:memory-sync-outbox` — 20 tests (12 durable store, 6 emitter, 2 pre-existing).
`npx tsx --test packages/db/src/tally-xml.test.ts` — 20 tests.
`npm run test:security-gates` — 47 pass.
`npm run type-check --workspace @synapse/web` — clean.
`npm run db:check` — 197 files.
