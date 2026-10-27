const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

import { writeupFromEncounterMetadata } from "@synapse/db/clinical-writeup"

const MAX_CONTEXT_CHARS = 1_500

export type EncounterScope = {
  encounterId: string
  patientId: string | null
  /** Encounter chief complaint — default presenting complaint for the advisory. */
  chiefComplaint: string | null
  /**
   * Clinician-authored history/examination from the encounter write-up. Used for
   * on-screen evidence only; it is not sent to external AI providers.
   */
  history: string[]
  examination: string[]
}

type EncounterRow = { id: string; patient_id: string | null; chief_complaint?: string | null; metadata?: unknown }

function clip(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_CONTEXT_CHARS) : null
}

/**
 * Resolve an encounter strictly inside the caller's tenant. Returns null when the
 * id is malformed or the encounter belongs to another tenant (indistinguishable
 * from "not found" so tenants cannot probe each other's ids).
 */
export async function loadEncounterScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  tenantId: string,
  encounterId: string,
): Promise<{ scope: EncounterScope | null; error: boolean }> {
  if (!isUuid(encounterId)) return { scope: null, error: false }
  const { data, error } = await db
    .from("encounters")
    .select("id, patient_id, chief_complaint, metadata")
    .eq("id", encounterId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) return { scope: null, error: true }
  const row = data as EncounterRow | null
  if (!row) return { scope: null, error: false }
  const writeup = writeupFromEncounterMetadata(row.metadata)
  const history = [writeup.hpi, writeup.pmh].map(clip).filter((v): v is string => Boolean(v))
  const examination = [writeup.examination].map(clip).filter((v): v is string => Boolean(v))
  return {
    scope: {
      encounterId: row.id,
      patientId: row.patient_id ?? null,
      chiefComplaint: typeof row.chief_complaint === "string" ? clip(row.chief_complaint) : null,
      history,
      examination,
    },
    error: false,
  }
}
