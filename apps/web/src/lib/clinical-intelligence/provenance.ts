export const ADVICE_EVENTS_TABLE = "clinical_ai_advice_events"

export type AdviceEventInput = {
  tenantId: string
  clinicianId: string
  eventType: "advice" | "override"
  patientId: string | null
  encounterId: string | null
  recommendationId: string | null
  task: string
  provider: string | null
  model: string | null
  decision: "ACCEPT" | "MODIFY" | "REJECT" | "DEFER" | null
  payload: Record<string, unknown>
}

export type AdviceEventResult =
  | { persisted: true }
  | { persisted: false; reason: "table_absent" | "write_failed" }

/** Postgres undefined_table, or PostgREST "relation not in schema cache". */
function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message ?? "")
}

/**
 * Append a provenance row. Never throws: when the (unapplied) migration is absent
 * the advisory flow still works and reports provenancePersisted=false.
 */
export async function recordAdviceEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: AdviceEventInput,
): Promise<AdviceEventResult> {
  try {
    const { error } = await db.from(ADVICE_EVENTS_TABLE).insert({
      tenant_id: input.tenantId,
      clinician_id: input.clinicianId,
      event_type: input.eventType,
      patient_id: input.patientId,
      encounter_id: input.encounterId,
      recommendation_id: input.recommendationId,
      task: input.task,
      provider: input.provider,
      model: input.model,
      decision: input.decision,
      payload: input.payload,
    })
    if (!error) return { persisted: true }
    return { persisted: false, reason: isMissingTable(error) ? "table_absent" : "write_failed" }
  } catch {
    return { persisted: false, reason: "write_failed" }
  }
}

export type AdviceEventLookup =
  | {
      status: "found"
      event: { encounterId: string | null; provider: string | null; model: string | null; availability: string | null }
    }
  | { status: "not_found" }
  | { status: "table_absent" }
  | { status: "error" }

/**
 * Find the advice event a clinician decision refers to, strictly inside the
 * caller's tenant. A recommendation id from another tenant is "not_found", so a
 * decision can never be attached to (or probe) another tenant's advice.
 */
export async function findAdviceEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  tenantId: string,
  recommendationId: string,
): Promise<AdviceEventLookup> {
  try {
    const { data, error } = await db
      .from(ADVICE_EVENTS_TABLE)
      .select("encounter_id, provider, model, payload")
      .eq("tenant_id", tenantId)
      .eq("event_type", "advice")
      .eq("recommendation_id", recommendationId)
      .limit(1)
      .maybeSingle()
    if (error) return isMissingTable(error) ? { status: "table_absent" } : { status: "error" }
    if (!data) return { status: "not_found" }
    const row = data as { encounter_id?: string | null; provider?: string | null; model?: string | null; payload?: unknown }
    const payload = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {}
    return {
      status: "found",
      event: {
        encounterId: row.encounter_id ?? null,
        provider: row.provider ?? null,
        model: row.model ?? null,
        availability: typeof payload.availability === "string" ? payload.availability : null,
      },
    }
  } catch {
    return { status: "error" }
  }
}
