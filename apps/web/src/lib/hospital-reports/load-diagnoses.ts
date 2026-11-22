import type { SurveillanceRow } from '@synapse/interop/epi-surveillance'

const CHUNK = 400

/**
 * Coded diagnoses for this facility's encounters in [start, end), with the
 * patient's age, sex and district for aggregation. Tenant and hospital scoped.
 * Returns rows for aggregate reports only; nothing identifying is kept.
 */
export async function loadFacilityDiagnoses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  scope: { tenantId: string; hospitalId: string },
  range: { start: string; end: string },
  cap: number,
): Promise<{ rows: SurveillanceRow[]; encounters: number; truncated: boolean } | { error: string }> {
  const { data: encounters, error } = await db
    .from('encounters')
    .select('id, visit_date, patients(dob, date_of_birth, sex, district)')
    .eq('tenant_id', scope.tenantId)
    .eq('hospital_id', scope.hospitalId)
    .eq('is_deleted', false)
    .gte('visit_date', range.start)
    .lt('visit_date', range.end)
    .limit(cap)
  if (error) return { error: 'Could not load encounters' }

  type Enc = { id: string; visit_date: string; patients?: { dob?: string | null; date_of_birth?: string | null; sex?: string | null; district?: string | null } | null }
  const byId = new Map<string, Enc>((encounters ?? []).map((e: Enc) => [e.id, e]))
  const ids = [...byId.keys()]
  const rows: SurveillanceRow[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data: dx, error: dxError } = await db
      .from('encounter_diagnoses')
      .select('encounter_id, stem_code, certainty')
      .eq('tenant_id', scope.tenantId)
      .eq('is_deleted', false)
      .in('encounter_id', ids.slice(i, i + CHUNK))
    if (dxError) return { error: 'Could not load diagnoses' }
    for (const d of (dx ?? []) as { encounter_id: string; stem_code: string; certainty: string | null }[]) {
      const e = byId.get(d.encounter_id)
      if (!e) continue
      rows.push({
        encounter_id: d.encounter_id,
        stem_code: d.stem_code,
        certainty: d.certainty,
        visit_date: e.visit_date,
        dob: e.patients?.dob ?? e.patients?.date_of_birth ?? null,
        sex: e.patients?.sex ?? null,
        district: e.patients?.district ?? null,
      })
    }
  }
  return { rows, encounters: ids.length, truncated: ids.length >= cap }
}
