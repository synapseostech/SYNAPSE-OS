/**
 * One-shot state for the Tally cut-over.
 *
 * The cut-over exists to move a pharmacy off Tally once. Its completion is read
 * from the import session that finished, so no extra column is needed: a tenant
 * with a completed Tally session has been cut over and the workspace stays
 * read-only from then on.
 */

import { supabaseAdmin } from "@/lib/supabase/admin"

const db = () => supabaseAdmin as any

export type TallyCutover = {
  sessionId: string
  completedAt: string | null
}

export async function findCompletedCutover(tenantId: string): Promise<TallyCutover | null> {
  const { data } = await db()
    .from("pharmacy_import_sessions")
    .select("id, completed_at")
    .eq("tenant_id", tenantId)
    .eq("source_system", "Tally")
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  return { sessionId: String(data.id), completedAt: data.completed_at ?? null }
}

export const CUTOVER_ALREADY_COMPLETE = {
  error: "The Tally cut-over for this pharmacy is already complete.",
  code: "TALLY_CUTOVER_COMPLETE",
  humanMessage:
    "This pharmacy has already been cut over from Tally. The import is one-shot and does not run again.",
} as const
