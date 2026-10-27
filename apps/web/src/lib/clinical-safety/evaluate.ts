/**
 * Clinical safety evaluation. Pure: same inputs, same alerts, no I/O.
 *
 * The three checks are not equally trustworthy today, and the result says so:
 *
 *   allergies      — driven by real patient records, already populated.
 *   interactions   — driven by `drug_interactions`, which no migration seeds.
 *   contraindications — driven by `drug_contraindications`, also unseeded.
 *   dose           — driven by `drug_dose_adjustments`, also unseeded.
 *
 * A verdict of "no alerts" from an empty catalogue is not a verdict. The
 * evaluator therefore reports coverage per domain and marks the evaluation
 * indeterminate when a domain it needed could not have contained the answer.
 */

import {
  matchesAnyName,
  matchesAtcPrefix,
  matchesIcd,
} from './normalise'
import type {
  CandidateDrug,
  SafetyAlert,
  SafetyCoverage,
  SafetyEvaluation,
  SafetyInputs,
  SafetySeverity,
} from './types'

const SEVERITY_RANK: Record<SafetySeverity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

export function severityRank(severity: SafetySeverity): number {
  return SEVERITY_RANK[severity]
}

function bySeverityThenKey(a: SafetyAlert, b: SafetyAlert): number {
  const diff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
  return diff !== 0 ? diff : a.key.localeCompare(b.key)
}

/** Allergy severity → alert severity. `unknown` is deliberately not `low`. */
function allergySeverity(raw: string): SafetySeverity {
  switch ((raw ?? '').toLowerCase()) {
    case 'anaphylaxis':
      return 'critical'
    case 'severe':
      return 'high'
    case 'moderate':
      return 'moderate'
    case 'mild':
      return 'low'
    default:
      // An unrecorded severity is a real allergy of unknown danger. It must not
      // rank below a known-mild one.
      return 'moderate'
  }
}

/** Interaction severity → alert severity. `contraindicated` outranks `major`. */
function interactionSeverity(raw: string): SafetySeverity {
  switch ((raw ?? '').toLowerCase()) {
    case 'contraindicated':
      return 'critical'
    case 'major':
    case 'severe':
      return 'high'
    case 'moderate':
      return 'moderate'
    case 'minor':
    case 'mild':
      return 'low'
    default:
      return 'moderate'
  }
}

function contraindicationSeverity(raw: string): SafetySeverity {
  return (raw ?? '').toLowerCase() === 'absolute' ? 'critical' : 'high'
}

export interface ParsedRange {
  operator: 'lt' | 'lte' | 'gt' | 'gte' | 'between'
  low: number
  high: number
  text: string
}

/**
 * Parse the free-text `reference_range` on a dose-adjustment row.
 *
 * The column is `text NOT NULL`, so its format is a convention rather than a
 * constraint. A row we cannot parse is reported for manual review — it is never
 * silently skipped, because "we did not understand the rule" and "the rule does
 * not apply" are different claims.
 */
export function parseReferenceRange(raw: string | null | undefined): ParsedRange | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  // No signed numbers: in "30-60" the hyphen is a separator, not a minus. Renal,
  // weight and age bands are never negative.
  const numeric = text.replace(/,/g, '.').match(/\d+(?:\.\d+)?/g)
  if (!numeric || numeric.length === 0) return null

  const numbers = numeric.map(Number).filter((n) => Number.isFinite(n))
  const value = numbers[0]
  if (value === undefined) return null

  // Two open-ended bands joined by "or" (`<30 or >60`) are not one band, and
  // the model has no union. Keeping only the first would apply half the rule.
  if (numbers.length > 1 && /\bor\b/i.test(text)) return null

  // `30-60`, `30 to 60`, `30 – 60`
  const second = numbers[1]
  if (second !== undefined && /\d\s*(?:-|–|—|to)\s*\d/i.test(text)) {
    const low = Math.min(value, second)
    const high = Math.max(value, second)
    return { operator: 'between', low, high, text }
  }

  // Words next. "no less than" contains "less than", so the closed forms are
  // tested before the open ones.
  if (/\b(?:at least|no less than|not below|minimum of|minimum)\b/.test(text)) {
    return { operator: 'gte', low: value, high: value, text }
  }
  if (/\b(?:at most|no more than|not above|up to|maximum of|maximum)\b/.test(text)) {
    return { operator: 'lte', low: value, high: value, text }
  }
  if (/\b(?:less than|below|under|lower than)\b/.test(text)) {
    return { operator: 'lt', low: value, high: value, text }
  }
  if (/\b(?:greater than|more than|above|over|exceeds|higher than)\b/.test(text)) {
    return { operator: 'gt', low: value, high: value, text }
  }

  if (/<=|≤/.test(text)) return { operator: 'lte', low: value, high: value, text }
  if (/>=|≥/.test(text)) return { operator: 'gte', low: value, high: value, text }
  if (/</.test(text)) return { operator: 'lt', low: value, high: value, text }
  if (/>/.test(text)) return { operator: 'gt', low: value, high: value, text }

  // A bare number is not an equality claim. Treating "30" as `value === 30`
  // would turn an unknown rule into a confident one; returning null sends it to
  // the manual-review path instead.
  return null
}

export function rangeApplies(range: ParsedRange, value: number): boolean {
  switch (range.operator) {
    case 'lt':
      return value < range.low
    case 'lte':
      return value <= range.low
    case 'gt':
      return value > range.low
    case 'gte':
      return value >= range.low
    case 'between':
      return value >= range.low && value <= range.high
    default:
      return false
  }
}

function namesOf(drug: CandidateDrug): Array<string | null | undefined> {
  return [drug.label, ...drug.aliases]
}

function newDrugs(candidates: CandidateDrug[]): CandidateDrug[] {
  return candidates.filter((drug) => drug.role === 'new')
}

function evaluateAllergies(inputs: SafetyInputs): SafetyAlert[] {
  const alerts: SafetyAlert[] = []
  const drugs = newDrugs(inputs.candidates)
  if (drugs.length === 0) return alerts

  for (const allergy of inputs.allergies) {
    for (const drug of drugs) {
      const nameMatch = matchesAnyName(namesOf(drug), allergy.allergen)
      const atcMatch = matchesAtcPrefix(drug.atcCode, allergy.atc_code)
      if (nameMatch === 'none' && !atcMatch) continue

      const severity = allergySeverity(allergy.severity)
      const basis = atcMatch && nameMatch === 'none'
        ? `recorded allergy to ATC ${allergy.atc_code}`
        : nameMatch === 'exact'
          ? `recorded allergy to ${allergy.allergen}`
          : `recorded allergy to ${allergy.allergen} (matched on "${allergy.allergen}")`

      alerts.push({
        kind: 'allergy_match',
        severity,
        key: `allergy_match:${allergy.id}:${drug.productId ?? drug.label}`,
        title: `Allergy: ${allergy.allergen} (${allergy.severity || 'severity unknown'})`,
        detail: [
          `${drug.label} is being ordered against a ${basis}.`,
          allergy.reaction ? `Recorded reaction: ${allergy.reaction}.` : null,
          allergy.verified ? null : `This allergy is unverified (${allergy.origin}).`,
        ]
          .filter(Boolean)
          .join(' '),
        sourceTable: allergy.origin,
        sourceId: allergy.id,
        drugs: [drug.label, allergy.allergen],
      })
    }
  }
  return alerts
}

function evaluateInteractions(inputs: SafetyInputs): SafetyAlert[] {
  const alerts: SafetyAlert[] = []
  const drugs = newDrugs(inputs.candidates)
  if (drugs.length === 0) return alerts

  for (const row of inputs.interactions) {
    const aNew = drugs.some((drug) => matchesAnyName(namesOf(drug), row.drug_a_name) !== 'none')
    const bNew = drugs.some((drug) => matchesAnyName(namesOf(drug), row.drug_b_name) !== 'none')
    if (!aNew && !bNew) continue

    // The pair matters: one side must be the drug under this decision, and the
    // other must actually be in play for this patient — on the current regimen,
    // or the second drug of a multi-drug order. A row naming the new drug
    // against something the patient is not taking is not an interaction.
    const otherName = aNew ? row.drug_b_name : row.drug_a_name
    const otherPresent = inputs.candidates.some(
      (drug) => matchesAnyName(namesOf(drug), otherName) !== 'none',
    )
    if (!otherPresent) continue

    const severity = interactionSeverity(row.severity)
    alerts.push({
      kind: 'interaction',
      severity,
      key: `interaction:${row.id}`,
      title: `Interaction: ${row.drug_a_name} + ${row.drug_b_name} (${row.severity})`,
      detail: [row.clinical_effect, row.mechanism ? `Mechanism: ${row.mechanism}` : null]
        .filter(Boolean)
        .join(' '),
      sourceTable: 'drug_interactions',
      sourceId: row.id,
      drugs: [row.drug_a_name, row.drug_b_name],
      recommendation: row.management ?? undefined,
    })
  }
  return alerts
}

function evaluateContraindications(inputs: SafetyInputs): SafetyAlert[] {
  const alerts: SafetyAlert[] = []
  const drugs = newDrugs(inputs.candidates)
  if (drugs.length === 0) return alerts

  for (const row of inputs.contraindications) {
    const drug = drugs.find((candidate) => matchesAnyName(namesOf(candidate), row.drug_name) !== 'none')
    if (!drug) continue

    const conditionMatch = inputs.diagnoses.some(
      (diagnosis) =>
        matchesIcd(diagnosis.code, row.condition_icd11) ||
        (diagnosis.name ? matchesAnyName([row.condition_name], diagnosis.name) === 'exact' : false),
    )
    if (!conditionMatch) continue

    alerts.push({
      kind: 'contraindication',
      severity: contraindicationSeverity(row.severity),
      key: `contraindication:${row.id}`,
      title: `Contraindication: ${row.drug_name} in ${row.condition_name} (${row.severity})`,
      detail: row.reason,
      sourceTable: 'drug_contraindications',
      sourceId: row.id,
      drugs: [row.drug_name],
      recommendation: row.alternative ?? undefined,
    })
  }
  return alerts
}

function organValue(
  organType: string,
  inputs: SafetyInputs,
): { value: number; label: string } | null {
  switch (organType) {
    case 'renal':
      return inputs.renal ? { value: inputs.renal.value, label: inputs.renal.unit } : null
    case 'weight':
      return inputs.weightKg != null ? { value: inputs.weightKg, label: 'kg' } : null
    case 'age':
      return inputs.ageYears != null ? { value: inputs.ageYears, label: 'years' } : null
    default:
      return null
  }
}

function evaluateDose(inputs: SafetyInputs): SafetyAlert[] {
  const alerts: SafetyAlert[] = []
  const drugs = newDrugs(inputs.candidates)
  if (drugs.length === 0) return alerts

  for (const row of inputs.doseAdjustments) {
    const drug = drugs.find((candidate) => matchesAnyName(namesOf(candidate), row.drug_name) !== 'none')
    if (!drug) continue

    const observation = organValue(row.organ_type, inputs)
    if (!observation) {
      // The rule exists but the patient has no measurement to apply it to.
      alerts.push({
        kind: 'dose_adjustment',
        severity: 'info',
        key: `dose_adjustment:${row.id}`,
        title: `Dose guidance not evaluated: ${row.drug_name} (${row.organ_type})`,
        detail: `A ${row.organ_type} dose adjustment exists for ${row.drug_name}, but no ${row.organ_type} measurement is recorded for this patient. Review manually.`,
        sourceTable: 'drug_dose_adjustments',
        sourceId: row.id,
        drugs: [row.drug_name],
        recommendation: row.adjusted_dose ?? row.dose_note ?? undefined,
        dataQuality: true,
      })
      continue
    }

    const range = parseReferenceRange(row.reference_range)
    if (!range) {
      alerts.push({
        kind: 'dose_adjustment',
        severity: 'moderate',
        key: `dose_adjustment:${row.id}`,
        title: `Dose guidance unreadable: ${row.drug_name}`,
        detail: `The ${row.organ_type} band "${row.reference_range}" could not be interpreted, so it was not applied. Review manually.`,
        sourceTable: 'drug_dose_adjustments',
        sourceId: row.id,
        drugs: [row.drug_name],
        recommendation: row.adjusted_dose ?? row.dose_note ?? undefined,
        dataQuality: true,
      })
      continue
    }

    if (!rangeApplies(range, observation.value)) continue

    alerts.push({
      kind: 'dose_adjustment',
      severity: row.is_avoid ? 'critical' : 'high',
      key: `dose_adjustment:${row.id}`,
      title: row.is_avoid
        ? `Avoid ${row.drug_name}: ${row.organ_type} function ${observation.value} ${observation.label}`
        : `Dose adjustment: ${row.drug_name} at ${row.organ_type} ${observation.value} ${observation.label}`,
      detail: [
        row.standard_dose ? `Standard dose: ${row.standard_dose}.` : null,
        row.adjusted_dose ? `Adjusted dose: ${row.adjusted_dose}.` : null,
        row.dose_note ?? null,
        `Triggered by band "${range.text}" against ${observation.value} ${observation.label}.`,
      ]
        .filter(Boolean)
        .join(' '),
      sourceTable: 'drug_dose_adjustments',
      sourceId: row.id,
      drugs: [row.drug_name],
      recommendation: row.adjusted_dose ?? undefined,
    })
  }
  return alerts
}

/** Domains whose emptiness means the answer could not have been in the data. */
const RISK_DOMAINS = ['interactions', 'contraindications', 'doseAdjustments'] as const

function collectIndeterminate(coverage: SafetyCoverage): Array<keyof SafetyCoverage> {
  const domains: Array<keyof SafetyCoverage> = []
  for (const key of RISK_DOMAINS) {
    if (coverage[key].state !== 'loaded') domains.push(key)
  }
  // Allergy data is per patient: an empty list is a legitimate "no known
  // allergies", not a missing catalogue. It still becomes indeterminate when the
  // query itself failed.
  if (coverage.allergies.state === 'unavailable') domains.push('allergies')
  if (coverage.renalFunction.state === 'unavailable') domains.push('renalFunction')
  return domains
}

export function evaluateSafety(inputs: SafetyInputs): SafetyEvaluation {
  const alerts = [
    ...evaluateAllergies(inputs),
    ...evaluateInteractions(inputs),
    ...evaluateContraindications(inputs),
    ...evaluateDose(inputs),
  ].sort(bySeverityThenKey)

  const indeterminateDomains = collectIndeterminate(inputs.coverage)
  const highest = alerts.reduce<SafetySeverity | 'none'>((acc, alert) => {
    if (acc === 'none') return alert.severity
    return SEVERITY_RANK[alert.severity] > SEVERITY_RANK[acc] ? alert.severity : acc
  }, 'none')

  return {
    alerts,
    coverage: inputs.coverage,
    highest,
    indeterminate: indeterminateDomains.length > 0,
    indeterminateDomains,
  }
}
