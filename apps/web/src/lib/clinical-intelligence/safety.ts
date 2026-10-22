import {
  INTELLIGENCE_FORBIDDEN_ACTIONS,
  assertNotForbidden,
  type ClinicianActionRecord,
} from "@synapse/interop"
import type { ClinicalOverrideInput } from "./schemas"

export const WAVE1_TOOL_VERSION = "clinical-intelligence.wave1.0.1"

export function assertAdvisoryOnly(action?: string) {
  if (!action) return
  assertNotForbidden(action)
}

export function blockedForbiddenActions(): string[] {
  return [...INTELLIGENCE_FORBIDDEN_ACTIONS]
}

export function recordClinicianOverride(input: ClinicalOverrideInput): ClinicianActionRecord {
  return {
    recommendationId: input.recommendationId,
    decision: input.decision,
    clinicianId: input.clinicianId,
    reason: input.reason ?? null,
    modifiedText: input.modifiedText ?? null,
    at: new Date().toISOString(),
  }
}
