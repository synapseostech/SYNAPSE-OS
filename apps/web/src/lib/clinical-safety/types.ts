/**
 * Clinical safety: shared types.
 *
 * Deliberately free of I/O. Everything in this file is data, so the evaluation
 * logic can be exercised without a database.
 */

export type SafetySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info'

export type SafetyAlertKind =
  | 'allergy_match'
  | 'interaction'
  | 'contraindication'
  | 'dose_adjustment'
  | 'catalogue_gap'
  | 'lookup_unavailable'

export interface SafetyAlert {
  kind: SafetyAlertKind
  severity: SafetySeverity
  /** Stable identity: `<kind>:<source row id or code>`. Used for de-duplication and audit. */
  key: string
  title: string
  detail: string
  /** The catalogue row behind this alert, when one exists. */
  sourceTable?: string
  sourceId?: string
  /** Drug names involved, for display and for the audit record. */
  drugs?: string[]
  /** Dose advice, when the source row carries it. */
  recommendation?: string
  /**
   * True when the alert is about missing or unreadable data rather than about
   * the patient. These are never a substitute for a real finding, and the
   * evaluator marks the domains they cover as indeterminate.
   */
  dataQuality?: boolean
}

/**
 * `empty` and `unavailable` are the states that matter. A checker that cannot
 * tell "no risk found" from "no data to look in" will report safety it has not
 * established, so the state is part of the result rather than a log line.
 */
export type CoverageState = 'loaded' | 'empty' | 'unavailable'

export interface DomainCoverage {
  state: CoverageState
  /** Rows the source actually held (catalogue total, or rows for this patient). */
  rows: number
  reason?: string
}

export interface SafetyCoverage {
  allergies: DomainCoverage
  interactions: DomainCoverage
  contraindications: DomainCoverage
  doseAdjustments: DomainCoverage
  renalFunction: DomainCoverage
}

export interface SafetyEvaluation {
  alerts: SafetyAlert[]
  coverage: SafetyCoverage
  highest: SafetySeverity | 'none'
  /**
   * True when at least one domain could not exclude a risk because its source
   * was empty or unreachable. Distinct from "found a problem": this means
   * "cannot say".
   */
  indeterminate: boolean
  indeterminateDomains: Array<keyof SafetyCoverage>
}

/** A drug in play: the one being prescribed/dispensed, or one already on the regimen. */
export interface CandidateDrug {
  /** What the clinician typed, or the product name. */
  label: string
  /** Other names for the same drug: generic name, active ingredient, brand. */
  aliases: string[]
  atcCode?: string | null
  productId?: string | null
  /** `new` is the drug under this decision; `current` is background regimen. */
  role: 'new' | 'current'
}

export interface AllergyRow {
  id: string
  allergen: string
  allergen_type: string
  atc_code: string | null
  reaction: string | null
  severity: string
  verified: boolean
  /** Where the row came from: the structured table or the legacy `patients.allergies` jsonb. */
  origin: 'patient_allergies' | 'patients.allergies'
}

export interface InteractionRow {
  id: string
  drug_a_code: string
  drug_a_name: string
  drug_b_code: string
  drug_b_name: string
  severity: string
  mechanism: string | null
  clinical_effect: string
  management: string | null
}

export interface ContraindicationRow {
  id: string
  drug_code: string
  drug_name: string
  condition_icd11: string
  condition_name: string
  severity: string
  reason: string
  alternative: string | null
}

export interface DoseAdjustmentRow {
  id: string
  drug_code: string
  drug_name: string
  organ_type: string
  reference_range: string
  standard_dose: string | null
  adjusted_dose: string | null
  dose_note: string | null
  is_avoid: boolean
}

export interface RenalFunction {
  /** The value used, and what it is, so a clinician is never shown an unlabelled number. */
  value: number
  unit: string
  source: 'egfr' | 'creatinine_clearance' | 'cockcroft_gault'
  recordedAt: string | null
}

export interface DiagnosisRef {
  code: string
  name?: string | null
}

export interface SafetyInputs {
  candidates: CandidateDrug[]
  allergies: AllergyRow[]
  interactions: InteractionRow[]
  contraindications: ContraindicationRow[]
  doseAdjustments: DoseAdjustmentRow[]
  renal: RenalFunction | null
  diagnoses: DiagnosisRef[]
  /** Age and weight, when known, for `age` and `weight` dose-adjustment rows. */
  ageYears: number | null
  weightKg: number | null
  coverage: SafetyCoverage
}
