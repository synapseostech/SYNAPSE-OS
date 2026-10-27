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
