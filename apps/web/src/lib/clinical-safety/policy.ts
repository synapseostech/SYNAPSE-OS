/**
 * Enforcement policy.
 *
 * Whether an alert stops a prescription or merely warns is a clinical governance
 * decision, not an engineering one, so nothing here is hard-coded into the
 * evaluation. The defaults below are the safest reading of the current data and
 * are meant to be overridden per deployment; every override is recorded in the
 * audit row so a reviewer can see which policy was in force at the time.
 *
 * Why the defaults are not all `block`:
 *
 *   - Allergy data is real today, and a recorded severe allergy is decisive.
 *     Default: block at `high` (severe and anaphylaxis).
 *   - The interaction, contraindication and dose catalogues are empty in every
 *     environment this repository can build. Blocking on them would block
 *     nothing today and block everything on the day the first row is seeded by a
 *     partly-reviewed import. Default: warn, escalating to block only at
 *     `critical`.
 *   - Indeterminacy is a data-quality state, not a patient state. Default: warn,
 *     and it is surfaced on every response so it is visible rather than silent.
 */

import { severityRank } from './evaluate'
import type { SafetyAlert, SafetyEvaluation, SafetySeverity } from './types'

export type EnforcementMode = 'off' | 'warn' | 'block'

export type SafetyDomain =
  | 'allergy'
  | 'interaction'
  | 'contraindication'
  | 'dose'
  | 'indeterminate'

export interface DomainPolicy {
  mode: EnforcementMode
  /** Only alerts at or above this severity can block. Ignored when mode is not `block`. */
  blockAtOrAbove: SafetySeverity
}

export type SafetyPolicy = Record<SafetyDomain, DomainPolicy>

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  allergy: { mode: 'block', blockAtOrAbove: 'high' },
  interaction: { mode: 'warn', blockAtOrAbove: 'critical' },
  contraindication: { mode: 'warn', blockAtOrAbove: 'critical' },
  dose: { mode: 'warn', blockAtOrAbove: 'critical' },
  indeterminate: { mode: 'warn', blockAtOrAbove: 'critical' },
}

const SEVERITIES: SafetySeverity[] = ['info', 'low', 'moderate', 'high', 'critical']
const MODES: EnforcementMode[] = ['off', 'warn', 'block']
const DOMAINS: SafetyDomain[] = ['allergy', 'interaction', 'contraindication', 'dose', 'indeterminate']

const DOMAIN_TO_POLICY: Record<SafetyAlert['kind'], SafetyDomain> = {
  allergy_match: 'allergy',
  interaction: 'interaction',
  contraindication: 'contraindication',
  dose_adjustment: 'dose',
  catalogue_gap: 'indeterminate',
  lookup_unavailable: 'indeterminate',
}

function envKey(domain: SafetyDomain, field: 'MODE' | 'BLOCKAT'): string {
  return `CLINICAL_SAFETY_${domain.toUpperCase()}_${field}`
}

/**
 * Read the policy from the environment.
 *
 * An unparseable value never silently becomes the default in the security-
 * relevant direction: it is recorded as a warning and the DEFAULT is used, and
 * the caller surfaces that warning. `NODE_ENV=test` is not special-cased — the
 * policy must be the same object in test as in production, or the test proves
 * a different system.
 */
export function loadSafetyPolicy(
  env: Record<string, string | undefined> = process.env,
): { policy: SafetyPolicy; warnings: string[] } {
  const policy: SafetyPolicy = {} as SafetyPolicy
  const warnings: string[] = []

  for (const domain of DOMAINS) {
    const base = DEFAULT_SAFETY_POLICY[domain]
    const rawMode = env[envKey(domain, 'MODE')]
    const rawBlock = env[envKey(domain, 'BLOCKAT')]

    let mode = base.mode
    if (rawMode != null && rawMode !== '') {
      const candidate = rawMode.trim().toLowerCase() as EnforcementMode
      if (MODES.includes(candidate)) {
        mode = candidate
      } else {
        warnings.push(`${envKey(domain, 'MODE')}="${rawMode}" is not one of ${MODES.join('|')}; using "${base.mode}"`)
      }
    }

    let blockAtOrAbove = base.blockAtOrAbove
    if (rawBlock != null && rawBlock !== '') {
      const candidate = rawBlock.trim().toLowerCase() as SafetySeverity
      if (SEVERITIES.includes(candidate)) {
        blockAtOrAbove = candidate
      } else {
        warnings.push(`${envKey(domain, 'BLOCKAT')}="${rawBlock}" is not one of ${SEVERITIES.join('|')}; using "${base.blockAtOrAbove}"`)
      }
    }

    policy[domain] = { mode, blockAtOrAbove }
  }

  return { policy, warnings }
}

export interface SafetyDecision {
  decision: 'allow' | 'warn' | 'block'
  /** Alerts that justify a block under the active policy. */
  blocking: SafetyAlert[]
  /** Alert keys that would block if the policy were tightened. */
  suppressed: SafetyAlert[]
  reasons: string[]
  policyWarnings: string[]
}

export function policyForAlert(policy: SafetyPolicy, alert: SafetyAlert): DomainPolicy {
  return policy[DOMAIN_TO_POLICY[alert.kind]]
}

/**
 * Apply the policy to an evaluation.
 *
 * A `dataQuality` alert never blocks on its own: it says we could not apply a
 * rule, not that the rule was broken. What governs it is the `indeterminate`
 * policy, decided once from the domain coverage.
 */
export function decideSafety(
  evaluation: SafetyEvaluation,
  policy: SafetyPolicy,
  policyWarnings: string[] = [],
): SafetyDecision {
  const blocking: SafetyAlert[] = []
  const suppressed: SafetyAlert[] = []
  const reasons: string[] = []

  for (const alert of evaluation.alerts) {
    const domainPolicy = policyForAlert(policy, alert)
    if (domainPolicy.mode === 'off') continue

    // A data-quality alert says a rule could not be applied, never that it was
    // broken. It is always reported, never blocking, whatever the threshold.
    const clinicallyActionable = !alert.dataQuality
    const meetsThreshold = severityRank(alert.severity) >= severityRank(domainPolicy.blockAtOrAbove)

    if (domainPolicy.mode === 'block' && clinicallyActionable && meetsThreshold) {
      blocking.push(alert)
      reasons.push(`${alert.title} (policy: ${DOMAIN_TO_POLICY[alert.kind]} blocks at ${domainPolicy.blockAtOrAbove})`)
    } else {
      suppressed.push(alert)
    }
  }

  if (evaluation.indeterminate && policy.indeterminate.mode === 'block') {
    reasons.push(
      `Clinical safety could not exclude a risk: no usable data for ${evaluation.indeterminateDomains.join(', ')}`,
    )
  }

  if (blocking.length > 0 || (evaluation.indeterminate && policy.indeterminate.mode === 'block')) {
    return { decision: 'block', blocking, suppressed, reasons, policyWarnings }
  }

  // Anything the policy did not silence is a signal, including a data-quality
  // alert: "a rule could not be applied" is something the caller must show, even
  // though it never blocks.
  const hasSignal =
    suppressed.length > 0 || (evaluation.indeterminate && policy.indeterminate.mode !== 'off')

  return {
    decision: hasSignal ? 'warn' : 'allow',
    blocking,
    suppressed,
    reasons,
    policyWarnings,
  }
}

/** Shape the decision for an API response. Stable, and small enough to read. */
export function toResponsePayload(
  evaluation: SafetyEvaluation,
  decision: SafetyDecision,
) {
  return {
    decision: decision.decision,
    highest: evaluation.highest,
    indeterminate: evaluation.indeterminate,
    indeterminateDomains: evaluation.indeterminateDomains,
    coverage: evaluation.coverage,
    alerts: evaluation.alerts.map((alert) => ({
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      recommendation: alert.recommendation ?? null,
      dataQuality: alert.dataQuality === true,
    })),
    blockingAlerts: decision.blocking.map((alert) => alert.key),
    reasons: decision.reasons,
    policyWarnings: decision.policyWarnings,
  }
}
