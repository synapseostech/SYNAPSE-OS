/**
 * One-shot state for the Tally cut-over.
 *
 * Completion is recorded on the import session. A separate tenant row reserves
 * the first applying session and serializes its resumable apply requests.
 */

import { randomUUID } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase/admin"

const db = () => supabaseAdmin as any

export type TallyCutover = {
  sessionId: string
  completedAt: string | null
}

export type TallyApplyLease = {
  status: "acquired" | "busy" | "owned_by_another_session" | "invalid_session"
  token: string | null
}

export async function findTallyCutoverOwner(tenantId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("pharmacy_tally_cutover_locks")
    .select("session_id")
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) {
    throw new Error(`TALLY_CUTOVER_STATUS_UNAVAILABLE: ${error.message}`)
  }
  return typeof data?.session_id === "string" ? data.session_id : null
}

export async function acquireTallyApplyLease(
  tenantId: string,
  sessionId: string,
): Promise<TallyApplyLease> {
  const token = randomUUID()
  const { data, error } = await db().rpc("claim_pharmacy_tally_cutover_apply", {
    p_tenant_id: tenantId,
    p_session_id: sessionId,
    p_lease_token: token,
  })

  if (error) {
    throw new Error(`TALLY_CUTOVER_LOCK_UNAVAILABLE: ${error.message}`)
  }
  if (data === "acquired") return { status: "acquired", token }
  if (data === "busy" || data === "owned_by_another_session" || data === "invalid_session") {
    return { status: data, token: null }
  }
  throw new Error("TALLY_CUTOVER_LOCK_UNAVAILABLE: unexpected lock response")
}

export async function releaseTallyApplyLease(
  tenantId: string,
  sessionId: string,
  token: string,
): Promise<void> {
  const { data, error } = await db().rpc("release_pharmacy_tally_cutover_apply", {
    p_tenant_id: tenantId,
    p_session_id: sessionId,
    p_lease_token: token,
  })

  if (error || data !== true) {
    throw new Error(`TALLY_CUTOVER_LOCK_RELEASE_FAILED: ${error?.message ?? "lease not owned"}`)
  }
}

export async function findCompletedCutover(tenantId: string): Promise<TallyCutover | null> {
  // A rolled-back session stays complete in its own history but no longer
  // holds the pharmacy: its movements are reversed and the next import must be
  // able to start from a clean cut-over rather than being refused forever.
  const { data, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, completed_at")
    .eq("tenant_id", tenantId)
    .eq("source_system", "Tally")
    .eq("status", "complete")
    .is("ai_mapping->>reversedAt", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`TALLY_CUTOVER_STATUS_UNAVAILABLE: ${error.message}`)
  }
  if (!data) return null
  return { sessionId: String(data.id), completedAt: data.completed_at ?? null }
}

/**
 * The one-shot guard as a route applies it to an existing session.
 *
 * A session that declares itself a continuation of the completed session is
 * let through: preview and apply then validate the company, period and mode
 * before anything is written. Every other session is refused exactly as
 * before, so an ordinary second import still cannot start.
 */
export async function findCutoverBlockingSession(
  tenantId: string,
  sessionId: string,
): Promise<TallyCutover | null> {
  const cutover = await findCompletedCutover(tenantId)
  if (!cutover) return null
  if (cutover.sessionId === sessionId) return null

  const { data, error } = await db()
    .from("pharmacy_import_sessions")
    .select("ai_mapping")
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error) {
    throw new Error(`TALLY_CUTOVER_STATUS_UNAVAILABLE: ${error.message}`)
  }
  const mapping = (data?.ai_mapping ?? {}) as Record<string, unknown>
  const declared = mapping.continuationOf
  return typeof declared === "string" && declared === cutover.sessionId ? null : cutover
}

export const CUTOVER_ALREADY_COMPLETE = {
  error: "The Tally cut-over for this pharmacy is already complete.",
  code: "TALLY_CUTOVER_COMPLETE",
  humanMessage:
    "This pharmacy has already been cut over from Tally. The import is one-shot and does not run again.",
} as const
