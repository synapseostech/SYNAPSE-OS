/**
 * Persist the safety check to `medication_safety_checks`.
 *
 * The table already exists in production and had no writer. It is the difference
 * between "the system warned" and "the system can show that it warned, at the
 * moment it mattered, to the person who proceeded". Nothing in the prescribing
 * or dispensing path may depend on this write succeeding — a failed audit write
 * must not roll back a clinical action that was already authorised — so every
 * failure is returned rather than thrown.
 */

import type { SafetyDb } from './load'
import type { SafetyDecision } from './policy'
import type { SafetyEvaluation } from './types'

export interface SafetyRecordInput {
  db: SafetyDb
  tenantId: string
  hospitalId: string | null
  patientId: string
  encounterId: string | null
  actorId: string
  /** Which decision this check was attached to. */
  stage: 'prescribe' | 'dispense'
  drugs: Array<{ label: string; productId?: string | null }>
  evaluation: SafetyEvaluation
  decision: SafetyDecision
  overrideReason?: string | null
}

export interface SafetyRecordResult {
  ok: boolean
  id?: string
  error?: string
}

export async function recordSafetyCheck(input: SafetyRecordInput): Promise<SafetyRecordResult> {
  const recordId = crypto.randomUUID()
  const wasOverridden = input.decision.decision === 'block' && typeof input.overrideReason === 'string' && input.overrideReason.trim().length > 0

  try {
    const query = input.db.from('medication_safety_checks')
    // `insert` is not on the minimal query interface the evaluator needs, so the
    // builder is taken from the same client and used structurally here.
    const insertable = query as unknown as {
      insert(row: Record<string, unknown>): PromiseLike<{ error?: { message?: string } | null }>
    }

    const { error } = await insertable.insert({
      id: recordId,
      tenant_id: input.tenantId,
      hospital_id: input.hospitalId,
      patient_id: input.patientId,
      encounter_id: input.encounterId,
      created_by: input.actorId,
      pharmacist_id: input.stage === 'dispense' ? input.actorId : null,
      checked_at: new Date().toISOString(),
      drug_orders: input.drugs.map((drug) => ({
        label: drug.label,
        product_id: drug.productId ?? null,
        stage: input.stage,
      })),
      alerts_raised: input.evaluation.alerts.map((alert) => ({
        key: alert.key,
        kind: alert.kind,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        recommendation: alert.recommendation ?? null,
        data_quality: alert.dataQuality === true,
        source_table: alert.sourceTable ?? null,
        source_id: alert.sourceId ?? null,
        drugs: alert.drugs ?? [],
      })),
      alert_count: input.evaluation.alerts.filter((alert) => !alert.dataQuality).length,
      was_overridden: wasOverridden,
      override_by: wasOverridden ? input.actorId : null,
      override_reason: wasOverridden ? input.overrideReason ?? null : null,
      // The policy in force is recorded with the check, because a reviewer
      // reading this row in six months cannot infer it from the code that
      // happens to be deployed then.
      policy_snapshot: {
        decision: input.decision.decision,
        reasons: input.decision.reasons,
        policy_warnings: input.decision.policyWarnings,
        coverage: input.evaluation.coverage,
        indeterminate: input.evaluation.indeterminate,
        indeterminate_domains: input.evaluation.indeterminateDomains,
      },
    })

    if (error) return { ok: false, error: error.message ?? 'medication_safety_checks insert failed' }
    return { ok: true, id: recordId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'medication_safety_checks insert threw' }
  }
}
