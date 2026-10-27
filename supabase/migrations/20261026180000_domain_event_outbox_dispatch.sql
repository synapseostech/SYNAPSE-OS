-- PREPARED ONLY — NOT APPLIED.
--
-- The connector relay (packages/interop/src/runtime/relay.ts) schedules retries
-- and takes a lease on the rows it is working. `public.synapse_domain_events`
-- has neither: it carries `retry_count`, `last_error` and `published_at`, but no
-- "try this again at" time and no "a worker has this row" marker. Without them a
-- relay either retries immediately in a hot loop or two workers deliver the same
-- event.
--
-- This is additive and catalogue-only on PG11+: both columns are nullable with no
-- default, so Postgres records the change without rewriting the table, and the
-- index is built concurrently-safely only when the table is small. It changes no
-- existing row and no policy.
--
-- Apply through the normal dispatch path, with the rest of the pending set. Until
-- it is applied, the durable store in packages/db/src/domain-event-outbox-store.ts
-- must not be wired to a live relay.

alter table if exists public.synapse_domain_events
  add column if not exists next_attempt_at timestamptz,
  add column if not exists locked_until timestamptz;

comment on column public.synapse_domain_events.next_attempt_at is
  'Earliest time the relay may attempt this event again. Null means due now.';
comment on column public.synapse_domain_events.locked_until is
  'Lease held by a relay worker. Null or in the past means claimable. Not a retry marker.';

-- The dispatch query is always "due rows for one status set, oldest first".
create index if not exists synapse_domain_events_dispatch_idx
  on public.synapse_domain_events (status, next_attempt_at, created_at)
  where status in ('pending', 'failed');
