import {
  INTELLIGENCE_PROMPT_VERSION,
  authorizePacketTenant,
  buildRecommendation,
  searchIcd11,
  stripInventedIcdCodes,
  type StructuredRecommendation,
} from "@synapse/interop"
import { suggestPathwaysFromContext } from "@synapse/db/pathways"
import { extractJsonObject } from "../ai/clinical-json"
import { summarizeContextForPrompt } from "./context-engine"
import { routeClinicalProvider } from "./provider-router"
import { WAVE1_TOOL_VERSION, blockedForbiddenActions } from "./safety"
import type { ClinicalAdviceRequest, ClinicalAdviceResponse } from "./schemas"

const SYSTEM = `You are SYNAPSE Clinical Intelligence Wave 1 — advisory only.
You never sign diagnoses, place orders, activate pathways, prescribe, dispense, or certify death.
Return compact JSON with keys: recommendation, reasoningSummary, supportingEvidence, contradictingEvidence,
missingInformation, confidence (0-1), cannotMiss (boolean), proposedTerms (string[]), suggestedPathwayId (string|null),
icd11StemHints (string[] of ICD-11 stem codes you believe apply — they will be validated server-side).`

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
}

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
  })

  let conditionName = input.packet.presentingComplaint
  let cantMiss = /sepsis|stroke|haemorrh|meningit/i.test(input.packet.presentingComplaint)
  let confidence = 0.4
  let aiReasoning = "Provider unavailable — deterministic advisory fallback. Clinician decides."
  let supportingEvidence: string[] = []
  let contradictingEvidence: string[] = []
  let missingInformation: string[] = []
  let proposedTerms: string[] = []
  let suggestedPathwayId: string | null = suggested[0]?.pathwayId ?? null
  let icd11StemHints: string[] = []

  let model: string | null = null
  let providerId: ClinicalAdviceResponse["provider"] = "mock"

  if (provider.ok) {
    model = provider.model
    providerId = provider.provider
    try {
      const raw = extractJsonObject(provider.content)
      conditionName = String(raw.recommendation ?? raw.conditionName ?? conditionName)
      cantMiss = Boolean(raw.cannotMiss ?? cantMiss)
      confidence = Math.max(0, Math.min(1, Number(raw.confidence ?? 0.4)))
      aiReasoning = String(raw.reasoningSummary ?? aiReasoning)
      supportingEvidence = asStringArray(raw.supportingEvidence)
      contradictingEvidence = asStringArray(raw.contradictingEvidence)
      missingInformation = asStringArray(raw.missingInformation)
      proposedTerms = asStringArray(raw.proposedTerms)
      icd11StemHints = asStringArray(raw.icd11StemHints)
      if (typeof raw.suggestedPathwayId === "string" && raw.suggestedPathwayId) {
        suggestedPathwayId = raw.suggestedPathwayId
      }
    } catch {
      providerId = "mock"
      model = "mock-parse-fallback"
    }
  } else {
    model = "mock-provider-unavailable"
  }

  // ICD validation: only keep stems that exist in the local ICD-11 cache
  const validatedHints = icd11StemHints.filter((hint) => {
    const hits = searchIcd11(hint)
    return hits.some((h) => h.stemCode === hint || h.stemCode.startsWith(hint) || hint.startsWith(h.stemCode))
  })

  const proposal = stripInventedIcdCodes({
    conditionName,
    cantMiss,
    confidence,
    aiReasoning,
    icd11Code: validatedHints[0] ?? null,
  })

  const recommendation: StructuredRecommendation = buildRecommendation({
    id: crypto.randomUUID(),
    task: input.task ?? "clinical_copilot",
    packet: input.packet,
    proposal,
    model,
  })

  if (supportingEvidence.length) recommendation.supportingEvidence = supportingEvidence
  if (contradictingEvidence.length) recommendation.contradictingEvidence = contradictingEvidence
  if (missingInformation.length) recommendation.missingInformation = missingInformation
  if (proposedTerms.length) recommendation.proposedTerms = proposedTerms
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
        ...validatedHints.map((c) => `icd11:${c}`),
      ]),
    ],
  }

  return {
    ok: true,
    advisory: true,
    humanOverrideRequired: true,
    featureFlag: "CLINICAL_INTELLIGENCE_WAVE1",
    provider: providerId,
    model,
    recommendation,
    suggestedPathwayIds: suggested.map((p) => p.pathwayId),
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
