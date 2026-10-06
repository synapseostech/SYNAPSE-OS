import type { ClinicianDecision, PatientContextPacket, StructuredRecommendation } from "@synapse/interop"

export type ClinicalProviderId = "openrouter" | "google" | "deepseek" | "nvidia" | "mock"

export type ClinicalAdviceRequest = {
  packet: PatientContextPacket
  task?: "clinical_copilot" | "pathway_copilot" | "coding_copilot"
  /** When true, never call a live provider — unit/integration tests. */
  forceMock?: boolean
}

export type ClinicalAdviceResponse = {
  ok: true
  advisory: true
  humanOverrideRequired: true
  featureFlag: "CLINICAL_INTELLIGENCE_WAVE1"
  provider: ClinicalProviderId
  model: string | null
  recommendation: StructuredRecommendation
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

export type ClinicalOverrideInput = {
  recommendationId: string
  decision: ClinicianDecision
  clinicianId: string
  reason?: string | null
  modifiedText?: string | null
}
