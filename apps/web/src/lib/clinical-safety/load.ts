/**
 * Database adapter for the clinical safety evaluator.
 *
 * Every query is tenant-scoped. The connection used by these routes is the
 * service role, which bypasses RLS, so scoping is done here explicitly rather
 * than inherited from a policy.
 *
 * Nothing in this file throws on a failed read. A read that fails becomes a
 * coverage state, because a checker that treats "the query errored" as "no rows
 * matched" is worse than no checker: it reports safety it has not established.
 */

import { normaliseName } from './normalise'
import type {
  AllergyRow,
  CandidateDrug,
  ContraindicationRow,
  DiagnosisRef,
  DoseAdjustmentRow,
  InteractionRow,
  RenalFunction,
  SafetyCoverage,
  SafetyInputs,
  DomainCoverage,
} from './types'

export interface QueryResult {
  data?: unknown
  error?: { message?: string } | null
  count?: number | null
}

export interface SafetyQuery extends PromiseLike<QueryResult> {
  select(columns: string, options?: { count?: 'exact'; head?: boolean }): SafetyQuery
  eq(column: string, value: unknown): SafetyQuery
  in(column: string, values: readonly unknown[]): SafetyQuery
  or(filter: string): SafetyQuery
  order(column: string, options?: { ascending?: boolean }): SafetyQuery
  limit(count: number): SafetyQuery
  maybeSingle(): PromiseLike<QueryResult>
}

export interface SafetyDb {
  from(table: string): SafetyQuery
}

export interface SafetyContext {
  db: SafetyDb
  tenantId: string
  patientId: string
  encounterId: string
}

type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; message: string }
type CountResult = { ok: true; count: number } | { ok: false; message: string }

function messageOf(error: { message?: string } | null | undefined, fallback: string): string {
  return error?.message ?? fallback
}

async function readRows<T>(query: SafetyQuery, fallback: string): Promise<ReadResult<T>> {
  try {
    const { data, error } = await query
    if (error) return { ok: false, message: messageOf(error, fallback) }
    return { ok: true, rows: Array.isArray(data) ? (data as T[]) : [] }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : fallback }
  }
}

async function readCount(query: SafetyQuery, fallback: string): Promise<CountResult> {
  try {
    const { count, error } = await query
    if (error) return { ok: false, message: messageOf(error, fallback) }
    return { ok: true, count: typeof count === 'number' ? count : 0 }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : fallback }
  }
}

/**
 * The discriminator for a catalogue query: the longest identity token of each
 * candidate name. `ilike` narrows the fetch; the exact decision is made in
 * `evaluate.ts` on normalised tokens, never in SQL.
 *
 * Normalisation has already removed everything outside `[a-z0-9]`, so a token
 * cannot inject PostgREST filter syntax. It is re-checked anyway.
 */
function discriminatorTokens(names: Array<string | null | undefined>, limit = 8): string[] {
  const tokens = new Set<string>()
  for (const name of names) {
    const identity = normaliseName(name).filter((token) => /^[a-z0-9]+$/.test(token) && token.length >= 4)
    if (identity.length === 0) continue
    const longest = identity.reduce((a, b) => (b.length > a.length ? b : a))
    tokens.add(longest)
    if (tokens.size >= limit) break
  }
  return [...tokens]
}

function catalogueCoverage(
  total: CountResult,
  matched: ReadResult<unknown>,
  table: string,
): DomainCoverage {
  if (!total.ok) {
    return { state: 'unavailable', rows: 0, reason: `could not read ${table}: ${total.message}` }
  }
  if (!matched.ok) {
    return { state: 'unavailable', rows: 0, reason: `could not query ${table}: ${matched.message}` }
  }
  if (total.count === 0) {
    return {
      state: 'empty',
      rows: 0,
      reason: `${table} has no rows in this environment; risks it would carry cannot be excluded`,
    }
  }
  return { state: 'loaded', rows: matched.rows.length }
}

/**
 * `tenant_id` on the clinical catalogues is nullable: a null row is a shared
 * reference entry, a non-null row belongs to one tenant. Both are in scope.
 */
function tenantFilter(tenantId: string): string {
  return `tenant_id.is.null,tenant_id.eq.${tenantId}`
}

async function loadAllergies(ctx: SafetyContext): Promise<ReadResult<AllergyRow> & { coverage: DomainCoverage }> {
  const structured = await readRows<Record<string, unknown>>(
    ctx.db
      .from('patient_allergies')
      .select('id, allergen, allergen_type, atc_code, reaction, severity, verified')
      .eq('patient_id', ctx.patientId)
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .limit(200),
    'patient_allergies read failed',
  )

  if (!structured.ok) {
    return {
      ok: false,
      message: structured.message,
      coverage: { state: 'unavailable', rows: 0, reason: structured.message },
    }
  }

  const rows: AllergyRow[] = structured.rows
    .filter((row) => typeof row.allergen === 'string' && row.allergen.trim().length > 0)
    .map((row) => ({
      id: String(row.id),
      allergen: String(row.allergen),
      allergen_type: String(row.allergen_type ?? 'drug'),
      atc_code: (row.atc_code as string | null) ?? null,
      reaction: (row.reaction as string | null) ?? null,
      severity: String(row.severity ?? 'unknown'),
      verified: row.verified === true,
      origin: 'patient_allergies' as const,
    }))

  // The legacy jsonb column is a second source of truth for the same fact. It is
  // read so that a patient whose allergies were only ever entered there is not
  // silently treated as allergy-free; entries already present in the structured
  // table are collapsed by name.
  const seen = new Set(rows.map((row) => row.allergen.trim().toLowerCase()))
  const legacy = await readRows<{ allergies: unknown }>(
    ctx.db
      .from('patients')
      .select('allergies')
      .eq('id', ctx.patientId)
      .eq('tenant_id', ctx.tenantId)
      .limit(1),
    'patients.allergies read failed',
  )
  const legacyRow = legacy.ok ? legacy.rows[0] : undefined
  if (legacyRow) {
    const raw = legacyRow.allergies
    const entries = Array.isArray(raw) ? raw : []
    entries.forEach((entry, index) => {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
      const name =
        typeof entry === 'string'
          ? entry
          : typeof record?.allergen === 'string'
            ? record.allergen
            : typeof record?.name === 'string'
              ? record.name
              : null
      if (!name || name.trim().length === 0) return
      const key = name.trim().toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      rows.push({
        id: `legacy:${ctx.patientId}:${index}`,
        allergen: name,
        allergen_type: typeof record?.type === 'string' ? record.type : 'drug',
        atc_code: typeof record?.atc_code === 'string' ? record.atc_code : null,
        reaction: typeof record?.reaction === 'string' ? record.reaction : null,
        severity: typeof record?.severity === 'string' ? record.severity : 'unknown',
        verified: false,
        origin: 'patients.allergies',
      })
    })
  }

  return {
    ok: true,
    rows,
    coverage: { state: 'loaded', rows: rows.length },
  }
}

async function loadInteractions(
  ctx: SafetyContext,
  names: Array<string | null | undefined>,
): Promise<ReadResult<InteractionRow> & { coverage: DomainCoverage }> {
  const table = 'drug_interactions'
  const total = await readCount(
    ctx.db.from(table).select('id', { count: 'exact', head: true }).eq('is_active', true).or(tenantFilter(ctx.tenantId)),
    `${table} count failed`,
  )
  if (!total.ok) {
    return { ok: false, message: total.message, coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }
  if (total.count === 0) {
    return { ok: true, rows: [], coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }

  const tokens = discriminatorTokens(names)
  const filter = tokens
    .flatMap((token) => [`drug_a_name.ilike.%${token}%`, `drug_b_name.ilike.%${token}%`])
    .join(',')
  if (!filter) {
    return { ok: true, rows: [], coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }

  const matched = await readRows<Record<string, unknown>>(
    ctx.db
      .from(table)
      .select('id, drug_a_code, drug_a_name, drug_b_code, drug_b_name, severity, mechanism, clinical_effect, management')
      .eq('is_active', true)
      .or(tenantFilter(ctx.tenantId))
      .or(filter)
      .limit(500),
    `${table} query failed`,
  )

  if (!matched.ok) {
    return { ok: false, message: matched.message, coverage: catalogueCoverage(total, matched, table) }
  }

  const rows: InteractionRow[] = matched.rows.map((row) => ({
    id: String(row.id),
    drug_a_code: String(row.drug_a_code ?? ''),
    drug_a_name: String(row.drug_a_name ?? ''),
    drug_b_code: String(row.drug_b_code ?? ''),
    drug_b_name: String(row.drug_b_name ?? ''),
    severity: String(row.severity ?? ''),
    mechanism: (row.mechanism as string | null) ?? null,
    clinical_effect: String(row.clinical_effect ?? ''),
    management: (row.management as string | null) ?? null,
  }))

  return { ok: true, rows, coverage: catalogueCoverage(total, matched, table) }
}

async function loadContraindications(
  ctx: SafetyContext,
  names: Array<string | null | undefined>,
): Promise<ReadResult<ContraindicationRow> & { coverage: DomainCoverage }> {
  const table = 'drug_contraindications'
  const total = await readCount(
    ctx.db.from(table).select('id', { count: 'exact', head: true }).eq('is_active', true).or(tenantFilter(ctx.tenantId)),
    `${table} count failed`,
  )
  if (!total.ok) {
    return { ok: false, message: total.message, coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }
  if (total.count === 0) {
    return { ok: true, rows: [], coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }

  const tokens = discriminatorTokens(names)
  if (tokens.length === 0) {
    return { ok: true, rows: [], coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }

  const matched = await readRows<Record<string, unknown>>(
    ctx.db
      .from(table)
      .select('id, drug_code, drug_name, condition_icd11, condition_name, severity, reason, alternative')
      .eq('is_active', true)
      .or(tenantFilter(ctx.tenantId))
      .or(tokens.map((token) => `drug_name.ilike.%${token}%`).join(','))
      .limit(500),
    `${table} query failed`,
  )

  if (!matched.ok) {
    return { ok: false, message: matched.message, coverage: catalogueCoverage(total, matched, table) }
  }

  const rows: ContraindicationRow[] = matched.rows.map((row) => ({
    id: String(row.id),
    drug_code: String(row.drug_code ?? ''),
    drug_name: String(row.drug_name ?? ''),
    condition_icd11: String(row.condition_icd11 ?? ''),
    condition_name: String(row.condition_name ?? ''),
    severity: String(row.severity ?? ''),
    reason: String(row.reason ?? ''),
    alternative: (row.alternative as string | null) ?? null,
  }))

  return { ok: true, rows, coverage: catalogueCoverage(total, matched, table) }
}

async function loadDoseAdjustments(
  ctx: SafetyContext,
  names: Array<string | null | undefined>,
): Promise<ReadResult<DoseAdjustmentRow> & { coverage: DomainCoverage }> {
  const table = 'drug_dose_adjustments'
  const total = await readCount(
    ctx.db.from(table).select('id', { count: 'exact', head: true }).eq('is_active', true).or(tenantFilter(ctx.tenantId)),
    `${table} count failed`,
  )
  if (!total.ok) {
    return { ok: false, message: total.message, coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }
  if (total.count === 0) {
    return { ok: true, rows: [], coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }

  const tokens = discriminatorTokens(names)
  if (tokens.length === 0) {
    return { ok: true, rows: [], coverage: catalogueCoverage(total, { ok: true, rows: [] }, table) }
  }

  const matched = await readRows<Record<string, unknown>>(
    ctx.db
      .from(table)
      .select('id, drug_code, drug_name, organ_type, reference_range, standard_dose, adjusted_dose, dose_note, is_avoid')
      .eq('is_active', true)
      .or(tenantFilter(ctx.tenantId))
      .or(tokens.map((token) => `drug_name.ilike.%${token}%`).join(','))
      .limit(500),
    `${table} query failed`,
  )

  if (!matched.ok) {
    return { ok: false, message: matched.message, coverage: catalogueCoverage(total, matched, table) }
  }

  const rows: DoseAdjustmentRow[] = matched.rows.map((row) => ({
    id: String(row.id),
    drug_code: String(row.drug_code ?? ''),
    drug_name: String(row.drug_name ?? ''),
    organ_type: String(row.organ_type ?? ''),
    reference_range: String(row.reference_range ?? ''),
    standard_dose: (row.standard_dose as string | null) ?? null,
    adjusted_dose: (row.adjusted_dose as string | null) ?? null,
    dose_note: (row.dose_note as string | null) ?? null,
    is_avoid: row.is_avoid === true,
  }))

  return { ok: true, rows, coverage: catalogueCoverage(total, matched, table) }
}

interface PatientProfile {
  dob: string | null
  sex: string | null
  weightKg: number | null
}

async function loadPatientProfile(ctx: SafetyContext): Promise<PatientProfile | null> {
  const result = await readRows<Record<string, unknown>>(
    ctx.db
      .from('patients')
      .select('dob, sex, weight_kg')
      .eq('id', ctx.patientId)
      .eq('tenant_id', ctx.tenantId)
      .limit(1),
    'patients read failed',
  )
  if (!result.ok) return null
  const row = result.rows[0]
  if (!row) return null
  return {
    dob: (row.dob as string | null) ?? null,
    sex: (row.sex as string | null) ?? null,
    weightKg: row.weight_kg == null ? null : Number(row.weight_kg),
  }
}

function ageInYears(dob: string | null): number | null {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  const now = new Date()
  let age = now.getUTCFullYear() - born.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - born.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1
  return age >= 0 && age < 130 ? age : null
}

/**
 * Renal function, resolved in order of trustworthiness: measured eGFR, then a
 * recorded creatinine clearance, then Cockcroft-Gault.
 *
 * Cockcroft-Gault needs serum creatinine in mg/dL. `vitals.creatinine` has no
 * unit constraint and this deployment records µmol/L values. A value above 20
 * cannot be mg/dL, so instead of converting on a guess the estimate is refused
 * and the domain is reported unavailable — a wrong clearance figure is worse
 * than an absent one.
 */
async function loadRenalFunction(ctx: SafetyContext): Promise<{ renal: RenalFunction | null; coverage: DomainCoverage }> {
  const result = await readRows<Record<string, unknown>>(
    ctx.db
      .from('vitals')
      .select('egfr, creatinine_clearance, creatinine, weight_kg, recorded_at')
      .eq('encounter_id', ctx.encounterId)
      .eq('tenant_id', ctx.tenantId)
      .order('recorded_at', { ascending: false })
      .limit(10),
    'vitals read failed',
  )

  if (!result.ok) {
    return { renal: null, coverage: { state: 'unavailable', rows: 0, reason: result.message } }
  }

  const pick = (field: string): { value: number; recordedAt: string | null } | null => {
    for (const row of result.rows) {
      const raw = row[field]
      if (raw == null) continue
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) continue
      return { value, recordedAt: (row.recorded_at as string | null) ?? null }
    }
    return null
  }

  const egfr = pick('egfr')
  if (egfr) {
    return {
      renal: { value: egfr.value, unit: 'mL/min/1.73m²', source: 'egfr', recordedAt: egfr.recordedAt },
      coverage: { state: 'loaded', rows: result.rows.length },
    }
  }

  const clearance = pick('creatinine_clearance')
  if (clearance) {
    return {
      renal: { value: clearance.value, unit: 'mL/min', source: 'creatinine_clearance', recordedAt: clearance.recordedAt },
      coverage: { state: 'loaded', rows: result.rows.length },
    }
  }

  const creatinine = pick('creatinine')
  if (!creatinine) {
    return {
      renal: null,
      coverage: { state: 'empty', rows: result.rows.length, reason: 'no eGFR, creatinine clearance or creatinine recorded for this encounter' },
    }
  }

  if (creatinine.value > 20) {
    return {
      renal: null,
      coverage: {
        state: 'unavailable',
        rows: result.rows.length,
        reason: `creatinine ${creatinine.value} is not in mg/dL; the unit is not declared in the schema, so no clearance estimate was made`,
      },
    }
  }

  const profile = await loadPatientProfile(ctx)
  const age = ageInYears(profile?.dob ?? null)
  const weight = (result.rows.find((row) => row.weight_kg != null)?.weight_kg as number | undefined) ?? profile?.weightKg ?? null
  const sex = (profile?.sex ?? '').toLowerCase()

  if (age == null || weight == null || !(weight > 0)) {
    return {
      renal: null,
      coverage: {
        state: 'unavailable',
        rows: result.rows.length,
        reason: 'creatinine recorded but age or weight is missing, so creatinine clearance could not be estimated',
      },
    }
  }

  const base = ((140 - age) * Number(weight)) / (72 * creatinine.value)
  const value = sex.startsWith('f') ? base * 0.85 : base
  return {
    renal: {
      value: Math.round(value * 10) / 10,
      unit: 'mL/min (Cockcroft-Gault, estimated)',
      source: 'cockcroft_gault',
      recordedAt: creatinine.recordedAt,
    },
    coverage: { state: 'loaded', rows: result.rows.length },
  }
}

async function loadDiagnoses(ctx: SafetyContext): Promise<ReadResult<DiagnosisRef>> {
  const result = await readRows<Record<string, unknown>>(
    ctx.db
      .from('encounter_diagnoses')
      .select('stem_code, title, certainty')
      .eq('encounter_id', ctx.encounterId)
      .eq('tenant_id', ctx.tenantId)
      .limit(50),
    'encounter_diagnoses read failed',
  )
  if (!result.ok) return result
  return {
    ok: true,
    rows: result.rows
      .filter((row) => typeof row.stem_code === 'string' && row.stem_code.length > 0)
      .map((row) => ({ code: String(row.stem_code), name: (row.title as string | null) ?? null })),
  }
}

/**
 * The patient's current regimen: prescriptions that are still clinically live.
 * This is what makes the interaction check worth running — the risk is between
 * the drug being ordered now and the drugs the patient is already taking.
 */
async function loadRegimen(ctx: SafetyContext): Promise<ReadResult<CandidateDrug>> {
  const result = await readRows<Record<string, unknown>>(
    ctx.db
      .from('clinical_prescriptions')
      // `clinical_prescriptions` carries no product reference — the drug is a
      // free-text `medication_display`, and the dispense route records the
      // chosen product on the *sale*, not on the prescription. Name matching is
      // therefore the only join available here.
      .select('id, medication_display, status')
      .eq('patient_id', ctx.patientId)
      .eq('tenant_id', ctx.tenantId)
      .in('status', ['active', 'verified', 'dispensed'])
      .order('created_at', { ascending: false })
      .limit(50),
    'clinical_prescriptions read failed',
  )
  if (!result.ok) return result
  return {
    ok: true,
    rows: result.rows
      .filter((row) => typeof row.medication_display === 'string' && row.medication_display.trim().length > 0)
      .map((row) => ({
        label: String(row.medication_display),
        aliases: [],
        atcCode: null,
        productId: null,
        role: 'current' as const,
      })),
  }
}

/**
 * Patient data a domain could not read makes that domain unavailable, whatever
 * the catalogue said: the catalogue answered, but not for this patient.
 */
function degradeCoverage(coverage: DomainCoverage, reason: string): DomainCoverage {
  if (coverage.state === 'unavailable') return coverage
  return { state: 'unavailable', rows: coverage.rows, reason }
}

export async function loadSafetyInputs(ctx: SafetyContext, newDrugs: CandidateDrug[]): Promise<SafetyInputs> {
  const regimen = await loadRegimen(ctx)
  const regimenRows = regimen.ok ? regimen.rows : []
  const candidates: CandidateDrug[] = [...newDrugs, ...regimenRows]
  const names = candidates.flatMap((drug) => [drug.label, ...drug.aliases])

  const [allergies, interactions, contraindications, doseAdjustments, renalResult, diagnoses, profile] =
    await Promise.all([
      loadAllergies(ctx),
      loadInteractions(ctx, names),
      loadContraindications(ctx, names),
      loadDoseAdjustments(ctx, names),
      loadRenalFunction(ctx),
      loadDiagnoses(ctx),
      loadPatientProfile(ctx),
    ])

  const coverage: SafetyCoverage = {
    allergies: allergies.coverage,
    // The regimen and the diagnosis list belong to these domains, so losing
    // either read means the domain could not answer for this patient.
    interactions: regimen.ok
      ? interactions.coverage
      : degradeCoverage(interactions.coverage, `could not read the current regimen: ${regimen.message}`),
    contraindications: diagnoses.ok
      ? contraindications.coverage
      : degradeCoverage(contraindications.coverage, `could not read the encounter diagnoses: ${diagnoses.message}`),
    doseAdjustments: doseAdjustments.coverage,
    renalFunction: renalResult.coverage,
  }

  return {
    candidates,
    allergies: allergies.ok ? allergies.rows : [],
    interactions: interactions.ok ? interactions.rows : [],
    contraindications: contraindications.ok ? contraindications.rows : [],
    doseAdjustments: doseAdjustments.ok ? doseAdjustments.rows : [],
    renal: renalResult.renal,
    diagnoses: diagnoses.ok ? diagnoses.rows : [],
    ageYears: ageInYears(profile?.dob ?? null),
    weightKg: profile?.weightKg ?? null,
    coverage,
  }
}
