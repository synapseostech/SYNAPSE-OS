/**
 * The orchestrator the routes call.
 *
 * `runClinicalSafetyCheck` never throws. A safety check that fails is a state
 * the caller must see (`coverage.*.state === 'unavailable'`), not an exception
 * that turns into a 500 and takes the prescribing flow down with it. What the
 * caller does with the decision is the caller's business; what the check
 * promises is that the decision is never silently "allow" when the data was not
 * there to support it.
 */

import { evaluateSafety } from './evaluate'
import { loadSafetyInputs, type SafetyContext } from './load'
import { decideSafety, loadSafetyPolicy, toResponsePayload } from './policy'
import { recordSafetyCheck } from './record'
import type { CandidateDrug, SafetyEvaluation } from './types'
import type { SafetyDecision, SafetyPolicy } from './policy'

export interface RunSafetyCheckInput extends SafetyContext {
  hospitalId: string | null
  actorId: string
  stage: 'prescribe' | 'dispense'
  newDrugs: CandidateDrug[]
  overrideReason?: string | null
  /** Injected in tests; production reads the environment. */
  policy?: { policy: SafetyPolicy; warnings: string[] }
}

export interface RunSafetyCheckResult {
  evaluation: SafetyEvaluation
  decision: SafetyDecision
  payload: ReturnType<typeof toResponsePayload>
  auditRecordId?: string
  auditError?: string
}

function emptyCoverage() {
  const unavailable = { state: 'unavailable' as const, rows: 0, reason: 'clinical safety check did not run' }
  return {
    allergies: unavailable,
    interactions: unavailable,
    contraindications: unavailable,
    doseAdjustments: unavailable,
    renalFunction: unavailable,
  }
}

/**
 * A check that could not run must not read as a clean result. This builds the
 * evaluation for the failure path so the caller sees `indeterminate: true`
 * rather than zero alerts.
 */
function failedEvaluation(): SafetyEvaluation {
  return {
    alerts: [],
    coverage: emptyCoverage(),
    highest: 'none',
    indeterminate: true,
    indeterminateDomains: [
      'allergies',
      'interactions',
      'contraindications',
      'doseAdjustments',
      'renalFunction',
    ],
  }
}

export async function runClinicalSafetyCheck(input: RunSafetyCheckInput): Promise<RunSafetyCheckResult> {
  const { policy, warnings } = input.policy ?? loadSafetyPolicy()

  let evaluation: SafetyEvaluation
  try {
    const inputs = await loadSafetyInputs(
      {
        db: input.db,
        tenantId: input.tenantId,
        patientId: input.patientId,
        encounterId: input.encounterId,
      },
      input.newDrugs,
    )
    evaluation = evaluateSafety(inputs)
  } catch (error) {
    // loadSafetyInputs is written not to throw, but a bug in it must not become
    // a clean bill of health.
    console.warn('[clinical-safety] evaluation threw; reporting indeterminate', error)
    evaluation = failedEvaluation()
  }

  const decision = decideSafety(evaluation, policy, warnings)
  const payload = toResponsePayload(evaluation, decision)

  const audit = await recordSafetyCheck({
    db: input.db,
    tenantId: input.tenantId,
    hospitalId: input.hospitalId,
    patientId: input.patientId,
    encounterId: input.encounterId,
    actorId: input.actorId,
    stage: input.stage,
    drugs: input.newDrugs.map((drug) => ({ label: drug.label, productId: drug.productId ?? null })),
    evaluation,
    decision,
    overrideReason: input.overrideReason ?? null,
  })

  const result: RunSafetyCheckResult = { evaluation, decision, payload }
  if (audit.ok && audit.id) result.auditRecordId = audit.id
  if (!audit.ok && audit.error) result.auditError = audit.error
  return result
}
