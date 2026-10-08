import type { ClinicianDecision, PatientContextPacket, StructuredRecommendation } from "@synapse/interop"
import type { VerifiedIcd11Candidate } from "./model-output"
import type { ProviderFailureKind } from "./provider-router"

export type ClinicalProviderId = "openrouter" | "google" | "deepseek" | "nvidia" | "mock" | "none"

export type ClinicalAdviceRequest = {
  packet: PatientContextPacket
  task?: "clinical_copilot" | "pathway_copilot" | "coding_copilot"
  /** When true, never call a live provider — unit/integration tests. */
  forceMock?: boolean
  /** Test seams — never set from request input. */
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}

export type ClinicalAdviceResponse = {
  ok: true
  advisory: true
  /** Always an AI suggestion — never clinician documentation. */
  origin: "ai_suggestion"
  clinicianDocumentation: false
  humanOverrideRequired: true
  featureFlag: "CLINICAL_INTELLIGENCE_WAVE1"
  provider: ClinicalProviderId
  model: string | null
  /**
   * "unavailable" when no usable live model output exists (provider down, not
   * configured, invalid output, or mock refused in production). In that case
   * there is NO AI recommendation — never a mock or synthesized substitute.
   */
  availability: "available" | "unavailable"
  /** True only for the offline mock provider, which is refused in production. */
  synthetic: boolean
  /** True whenever availability is "unavailable". */
  degraded: boolean
  degradedReason: ProviderFailureKind | "invalid_model_output" | null
  /** Null when availability is "unavailable". */
  recommendation: StructuredRecommendation | null
  /** ICD-11 stems that exactly match the trusted cache; the clinician selects, AI never assigns. */
  icd11Candidates: VerifiedIcd11Candidate[]
  icd11HintsRejected: number
  /** Rule-based (non-AI) pathway matches from the governed catalog. */
  suggestedPathwayIds: string[]
  safety: {
    canActivatePathway: false
    canPlaceOrder: false
    canSignDiagnosis: false
    forbiddenActionsBlocked: string[]
  }
  provenance: {
    promptVersion: string
    toolVersion: string
    sources: string[]
    generatedAt: string
  }
}

export const CLINICIAN_DECISIONS = ["ACCEPT", "MODIFY", "REJECT", "DEFER"] as const

export type ClinicalOverrideInput = {
  recommendationId: string
  decision: ClinicianDecision
  clinicianId: string
  reason?: string | null
  modifiedText?: string | null
}
