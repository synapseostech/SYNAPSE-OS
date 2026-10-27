/**
 * Supabase implementation of `EventDeliveryClient`.
 *
 * Typed against the real `SupabaseClient` — not a hand-written structural
 * lookalike — so the query chains are checked against supabase-js itself. The
 * generated `Database` type in this package does not describe
 * `synapse_domain_events`, which is why the generic is left open rather than
 * pretending the table is typed; the row shapes are asserted by the store's
 * `DueEventRow`.
 *
 * What it deliberately does not do:
 *   - It never increments counters with arithmetic; PostgREST cannot. The store
 *     supplies absolute values.
 *   - It never decides retry policy. Every timestamp it writes was computed by
 *     the relay.
 *   - It does not filter by connector, because the table has no connector.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { DueEventRow, EventDeliveryClient } from "./domain-event-outbox-store"

const COLUMNS = "event_id, tenant_id, idempotency_key, payload, retry_count"

export function createSupabaseEventDeliveryClient(supabase: SupabaseClient): EventDeliveryClient {
  return {
    async listDue({ tenantId, limit, now }) {
      const iso = now.toISOString()
      const { data, error } = await supabase
        .from("synapse_domain_events")
        .select(COLUMNS)
        .eq("tenant_id", tenantId)
        .in("status", ["pending", "failed"])
        // Both filters are ORs over a nullable column, which PostgREST expresses
        // as `col.is.null,col.lte.<ts>`; chained calls are ANDed together.
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${iso}`)
        .or(`locked_until.is.null,locked_until.lte.${iso}`)
        .order("created_at", { ascending: true })
        .limit(limit)

      if (error) return { rows: [], error: error.message }
      return { rows: (data ?? []) as unknown as DueEventRow[], error: null }
    },

    async lease({ ids, until }) {
      if (ids.length === 0) return { error: null }
      const { error } = await supabase
        .from("synapse_domain_events")
        .update({ locked_until: until.toISOString() })
        .in("event_id", ids)
      return { error: error ? error.message : null }
    },

    async markPublished({ id, now }) {
      const { error } = await supabase
        .from("synapse_domain_events")
        .update({
          status: "published",
          published_at: now.toISOString(),
          last_error: null,
          locked_until: null,
          next_attempt_at: null,
        })
        .eq("event_id", id)
        // A row already published by a previous run must not be reopened.
        .in("status", ["pending", "failed"])
      return { error: error ? error.message : null }
    },

    async markFailed({ id, error: lastError, nextAttemptAt, retryCount }) {
      // `now` is intentionally unused: the table has nowhere to record a failure
      // time. `created_at` is immutable and `published_at` means published, so
      // adding one would need a column that does not exist. The retry schedule is
      // carried entirely by `next_attempt_at`.
      const { error } = await supabase
        .from("synapse_domain_events")
        .update({
          status: nextAttemptAt === null ? "dead" : "failed",
          last_error: lastError,
          retry_count: retryCount,
          locked_until: null,
          next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null,
        })
        .eq("event_id", id)
      return { error: error ? error.message : null }
    },
  }
}
