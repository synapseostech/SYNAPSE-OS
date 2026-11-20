/**
 * Row for public.encounter_diagnoses. Uses columns that already exist.
 * A stem-only clinician selection stores the stem in cluster_code because
 * that column is NOT NULL and a single stem is a one-member cluster.
 * created_by is omitted: it references auth.users, and selected_by is the
 * profile actor.
 */

export type EncounterDiagnosisInput = {
  encounterId: string
  tenantId: string
  selectedBy: string
  stemCode: string
  title: string
  foundationUri?: string | null
  linearizationUri?: string | null
  release?: string | null
  /** Defaults to confirmed (the clinician picked it). */
  certainty?: "confirmed" | "suspected" | "differential"
  diagnosisType?: "primary" | "secondary" | "comorbidity" | "complication"
  /** Set when the clinician accepted a Synapse differential suggestion. */
  suggestedBy?: "clinician" | "synapse_intelligence"
}

export function encounterDiagnosisRow(input: EncounterDiagnosisInput) {
  const stem = input.stemCode.trim()
  return {
    encounter_id: input.encounterId,
    tenant_id: input.tenantId,
    stem_code: stem,
    cluster_code: stem,
    title: input.title,
    certainty: input.certainty ?? ("confirmed" as const),
    diagnosis_type: input.diagnosisType ?? ("primary" as const),
    foundation_uri: input.foundationUri ?? null,
    linearization_uri: input.linearizationUri ?? null,
    icd_release: input.release ?? "2026-01",
    selected_by: input.selectedBy,
    suggested_by: input.suggestedBy ?? ("clinician" as const),
    is_deleted: false,
  }
}
