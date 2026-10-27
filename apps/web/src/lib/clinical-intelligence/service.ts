import {
  INTELLIGENCE_PROMPT_VERSION,
  authorizePacketTenant,
  buildRecommendation,
  stripInventedIcdCodes,
  type StructuredRecommendation,
} from "@synapse/interop"
import { suggestPathwaysFromContext } from "@synapse/db/pathways"
import { extractJsonObject } from "../ai/clinical-json"
import { summarizeContextForPrompt } from "./context-engine"
import { parseModelAdvice, verifyIcd11Hints, type ParsedModelAdvice } from "./model-output"
import { routeClinicalProvider } from "./provider-router"
import { WAVE1_TOOL_VERSION, blockedForbiddenActions } from "./safety"
import type { ClinicalAdviceRequest, ClinicalAdviceResponse } from "./schemas"

const SYSTEM = `You are SYNAPSE Clinical Intelligence Wave 1 — advisory only.
You never sign diagnoses, place orders, activate pathways, prescribe, dispense, or certify death.
Return compact JSON with keys: recommendation, reasoningSummary, supportingEvidence, contradictingEvidence,
missingInformation, confidence (0-1), cannotMiss (boolean), proposedTerms (string[]), suggestedPathwayId (string|null),
icd11StemHints (string[] of ICD-11 stem codes you believe apply — they will be validated server-side).`

const CANNOT_MISS_PATTERN = /sepsis|stroke|haemorrh|hemorrh|meningit/i
const FALLBACK_CONFIDENCE = 0.4

export async function adviseClinical(input: ClinicalAdviceRequest): Promise<ClinicalAdviceResponse> {
  authorizePacketTenant(input.packet, input.packet.tenantId)

  const suggested = suggestPathwaysFromContext({
    presentingComplaint: input.packet.presentingComplaint,
    vitals: input.packet.vitals,
    laboratory: input.packet.laboratory,
    diagnoses: input.packet.previousDiagnoses,
    countryPack: "UG",
  })

  const provider = await routeClinicalProvider({
    system: SYSTEM,
    user: summarizeContextForPrompt(input.packet),
    forceMock: input.forceMock,
    fetchImpl: input.fetchImpl,
    env: input.env,
  })

  let parsed: ParsedModelAdvice | null = null
  let degradedReason: ClinicalAdviceResponse["degradedReason"] = null

  if (provider.ok) {
    try {
      parsed = parseModelAdvice(extractJsonObject(provider.content))
    } catch {
      parsed = null
    }
    if (!parsed) degradedReason = "invalid_model_output"
  } else {
    degradedReason = provider.failure
  }

  const governedPathwayIds = suggested.map((p) => p.pathwayId)
  const generatedAt = new Date().toISOString()

  // No usable live model output: return an explicit "unavailable" result with
  // NO recommendation. Never substitute mock or synthesized advice.
  if (!provider.ok || !parsed) {
    return {
      ok: true,
      advisory: true,
      origin: "ai_suggestion",
      clinicianDocumentation: false,
      humanOverrideRequired: true,
      featureFlag: "CLINICAL_INTELLIGENCE_WAVE1",
      availability: "unavailable",
      synthetic: false,
      provider: "none",
      model: null,
      degraded: true,
      degradedReason,
      recommendation: null,
      icd11Candidates: [],
      icd11HintsRejected: 0,
      suggestedPathwayIds: governedPathwayIds,
      safety: {
        canActivatePathway: false,
        canPlaceOrder: false,
        canSignDiagnosis: false,
        forbiddenActionsBlocked: blockedForbiddenActions(),
      },
      provenance: {
        promptVersion: INTELLIGENCE_PROMPT_VERSION,
        toolVersion: WAVE1_TOOL_VERSION,
        sources: [...governedPathwayIds],
        generatedAt,
      },
    }
  }

  const model = provider.model
  const providerId: ClinicalAdviceResponse["provider"] = provider.provider
  const synthetic = provider.provider === "mock"

  const conditionName = parsed.recommendation
  const cantMiss = parsed.cannotMiss ?? CANNOT_MISS_PATTERN.test(input.packet.presentingComplaint)
  const confidence = parsed.confidence ?? FALLBACK_CONFIDENCE
  const aiReasoning = parsed.reasoningSummary ?? "No reasoning summary returned."

  const suggestedPathwayId = parsed.suggestedPathwayId ?? governedPathwayIds[0] ?? null

  const icd = verifyIcd11Hints(parsed.icd11StemHints ?? [])

  // The recommendation itself never carries a code: codes are clinician-selected
  // from the verified candidate list below.
  const proposal = stripInventedIcdCodes({
    conditionName,
    cantMiss,
    confidence,
    aiReasoning,
    icd11Code: null,
  })

  const recommendation: StructuredRecommendation = buildRecommendation({
    id: crypto.randomUUID(),
    task: input.task ?? "clinical_copilot",
    packet: input.packet,
    proposal,
    model,
  })

  if (parsed.supportingEvidence.length) recommendation.supportingEvidence = parsed.supportingEvidence
  if (parsed.contradictingEvidence.length) recommendation.contradictingEvidence = parsed.contradictingEvidence
  if (parsed.missingInformation.length) recommendation.missingInformation = parsed.missingInformation
  if (parsed.proposedTerms.length) recommendation.proposedTerms = parsed.proposedTerms
  recommendation.suggestedPathwayId = suggestedPathwayId ?? recommendation.suggestedPathwayId
  recommendation.provenance = {
    ...recommendation.provenance,
    model,
    promptVersion: INTELLIGENCE_PROMPT_VERSION,
    toolVersion: WAVE1_TOOL_VERSION,
    sources: [
      ...new Set([
        ...recommendation.provenance.sources,
        ...(suggestedPathwayId ? [suggestedPathwayId] : []),
        ...icd.verified.map((c) => `icd11:${c.stemCode}`),
      ]),
    ],
  }

  return {
    ok: true,
    advisory: true,
    origin: "ai_suggestion",
    clinicianDocumentation: false,
    humanOverrideRequired: true,
    featureFlag: "CLINICAL_INTELLIGENCE_WAVE1",
    availability: "available",
    synthetic,
    provider: providerId,
    model,
    degraded: false,
    degradedReason,
    recommendation,
    icd11Candidates: icd.verified,
    icd11HintsRejected: icd.rejected,
    suggestedPathwayIds: governedPathwayIds,
    safety: {
      canActivatePathway: false,
      canPlaceOrder: false,
      canSignDiagnosis: false,
      forbiddenActionsBlocked: blockedForbiddenActions(),
    },
    provenance: {
      promptVersion: INTELLIGENCE_PROMPT_VERSION,
      toolVersion: WAVE1_TOOL_VERSION,
      sources: recommendation.provenance.sources,
      generatedAt: new Date().toISOString(),
    },
  }
}
