/**
 * Pure view-model for the encounter AI suggestion panel. Kept free of React so
 * the clinician-facing labels and safety warnings are unit-tested.
 */

export type AdviceApiPayload = {
  ok?: boolean
  advisory?: boolean
  origin?: string
  degraded?: boolean
  degradedReason?: string | null
  provider?: string
  model?: string | null
  provenancePersisted?: boolean
  recommendation?: {
    id: string
    recommendation: string
    reasoningSummary?: string
    supportingEvidence?: string[]
    contradictingEvidence?: string[]
    missingInformation?: string[]
    confidence?: number
    cannotMiss?: boolean
    suggestedPathwayId?: string | null
  }
  icd11Candidates?: Array<{ stemCode: string; title: string; verified: boolean }>
  icd11HintsRejected?: number
}

export type AdviceView = {
  recommendationId: string
  headline: string
  label: string
  confidenceText: string
  reasoning: string | null
  evidenceFor: string[]
  evidenceAgainst: string[]
  suggestedInvestigations: string[]
  icd11: Array<{ code: string; title: string }>
  icd11RejectedNote: string | null
  pathwayNote: string | null
  warnings: string[]
  sourceNote: string
}

const DEGRADED_TEXT: Record<string, string> = {
  timeout: "The AI service timed out.",
  rate_limited: "The AI service is rate-limited right now.",
  unavailable: "The AI service is unavailable.",
  invalid_response: "The AI service returned an unusable response.",
  invalid_model_output: "The AI response failed validation and was discarded.",
  auth: "The AI service rejected its credentials.",
  not_configured: "No AI provider is configured.",
}

export function toAdviceView(payload: AdviceApiPayload): AdviceView | null {
  const rec = payload.recommendation
  if (!payload.ok || !rec?.id || typeof rec.recommendation !== "string") return null

  const warnings: string[] = []
  if (payload.degraded) {
    warnings.push(
      `${DEGRADED_TEXT[payload.degradedReason ?? ""] ?? "The AI service is degraded."} ` +
        "This is a rule-based fallback, not a model opinion. Continue documenting as normal.",
    )
  }
  if (rec.cannotMiss) {
    warnings.push("Cannot-miss condition flagged: assess and escalate per protocol. The AI does not trigger any action.")
  }

  const confidence = typeof rec.confidence === "number" && Number.isFinite(rec.confidence) ? rec.confidence : null
  const rejected = payload.icd11HintsRejected ?? 0

  return {
    recommendationId: rec.id,
    headline: rec.recommendation,
    label: "AI suggestion — not part of the clinical record. You decide.",
    confidenceText: confidence === null ? "Confidence: not reported" : `Model confidence: ${Math.round(confidence * 100)}%`,
    reasoning: rec.reasoningSummary?.trim() || null,
    evidenceFor: rec.supportingEvidence ?? [],
    evidenceAgainst: rec.contradictingEvidence ?? [],
    suggestedInvestigations: rec.missingInformation ?? [],
    icd11: (payload.icd11Candidates ?? [])
      .filter((c) => c.verified)
      .map((c) => ({ code: c.stemCode, title: c.title })),
    icd11RejectedNote:
      rejected > 0
        ? `${rejected} ICD-11 code suggestion${rejected === 1 ? "" : "s"} failed verification and ${rejected === 1 ? "was" : "were"} dropped.`
        : null,
    pathwayNote: rec.suggestedPathwayId
      ? `Related care pathway: ${rec.suggestedPathwayId} (advisory — open it yourself if appropriate).`
      : null,
    warnings,
    sourceNote: payload.degraded
      ? "Source: deterministic fallback"
      : `Source: ${payload.provider ?? "unknown"}${payload.model ? ` · ${payload.model}` : ""}`,
  }
}

export function adviceErrorMessage(status: number): string {
  if (status === 503) return "Clinical Intelligence is switched off for this environment."
  if (status === 401) return "Your session has expired. Sign in again."
  if (status === 403) return "Your role cannot request clinical AI suggestions."
  if (status === 404) return "Encounter not found."
  if (status === 429) return "Too many AI requests. Wait a minute and try again."
  return "AI suggestions are unavailable right now. Continue documenting as normal."
}
