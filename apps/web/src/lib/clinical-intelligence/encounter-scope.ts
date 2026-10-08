const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

export type EncounterScope = { encounterId: string; patientId: string | null }

type EncounterRow = { id: string; patient_id: string | null }

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
    .select("id, patient_id")
    .eq("id", encounterId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) return { scope: null, error: true }
  const row = data as EncounterRow | null
  if (!row) return { scope: null, error: false }
  return { scope: { encounterId: row.id, patientId: row.patient_id ?? null }, error: false }
}
