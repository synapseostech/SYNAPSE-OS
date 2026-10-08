import {
  completeOpenRouterChat,
  isOpenRouterConfigured,
  resolveOpenRouterModels,
} from "../ai/openrouter"
import type { ClinicalProviderId } from "./schemas"

export type ProviderFailureKind =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "auth"
  | "not_configured"

export type ProviderAttempt = {
  provider: ClinicalProviderId
  ok: boolean
  failure?: ProviderFailureKind
  status?: number
}

export type ProviderChatResult =
  | { ok: true; provider: ClinicalProviderId; model: string; content: string; attempts: ProviderAttempt[] }
  | {
      ok: false
      provider: ClinicalProviderId
      failure: ProviderFailureKind
      message: string
      attempts: ProviderAttempt[]
    }

const NVIDIA_OPENROUTER_MODELS = [
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
]

type DeepSeekCompletion = { choices?: Array<{ message?: { content?: string } }>; model?: string }

export const CLINICAL_PROVIDER_TIMEOUT_MS = 20_000

export function classifyProviderStatus(status: number): ProviderFailureKind {
  if (status === 429) return "rate_limited"
  if (status === 401 || status === 403) return "auth"
  if (status === 504 || status === 408) return "timeout"
  return "unavailable"
}

export const MOCK_CLINICAL_CONTENT = JSON.stringify({
  recommendation: "Consider infection workup; clinician must confirm.",
  reasoningSummary: "Mock advisory only — no live model called.",
  supportingEvidence: ["fever", "tachycardia"],
  contradictingEvidence: [],
  missingInformation: ["source of infection", "lactate"],
  confidence: 0.42,
  cannotMiss: true,
  proposedTerms: ["suspected sepsis"],
  suggestedPathwayId: "pathway.adult-sepsis",
  icd11StemHints: ["1G40"],
})

/**
 * Prefer OpenRouter (Google free models + optional NVIDIA via OpenRouter),
 * then direct DeepSeek if configured. forceMock never calls a live provider.
 * Every live call is bounded by a timeout; failures are classified so the
 * caller can degrade gracefully instead of surfacing raw provider errors.
 */
export async function routeClinicalProvider(input: {
  system: string
  user: string
  forceMock?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}): Promise<ProviderChatResult> {
  const env = input.env ?? process.env
  const timeoutMs = input.timeoutMs ?? CLINICAL_PROVIDER_TIMEOUT_MS
  const attempts: ProviderAttempt[] = []

  if (input.forceMock || env.CLINICAL_INTELLIGENCE_FORCE_MOCK === "1") {
    return { ok: true, provider: "mock", model: "mock-clinical-v1", content: MOCK_CLINICAL_CONTENT, attempts }
  }

  let lastFailure: { provider: ClinicalProviderId; failure: ProviderFailureKind; message: string } | null = null

  if (isOpenRouterConfigured(env)) {
    const preferNvidia = (env.CLINICAL_AI_PROVIDER ?? "").toLowerCase() === "nvidia"
    const providerId: ClinicalProviderId = preferNvidia ? "nvidia" : "openrouter"
    const models = preferNvidia
      ? [...NVIDIA_OPENROUTER_MODELS, ...resolveOpenRouterModels(env)]
      : resolveOpenRouterModels(env)
    const apiKey = env.OPENROUTER_API_KEY?.trim()
    if (apiKey) {
      const result = await completeOpenRouterChat({
        apiKey,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        models,
        temperature: 0.2,
        jsonMode: true,
        timeoutMs,
        fetchImpl: input.fetchImpl,
        title: "Synapse Clinical Intelligence Wave 1",
      })
      if (result.ok) {
        attempts.push({ provider: providerId, ok: true })
        return { ok: true, provider: providerId, model: result.model, content: result.content, attempts }
      }
      const failure = classifyProviderStatus(result.status)
      attempts.push({ provider: providerId, ok: false, failure, status: result.status })
      lastFailure = { provider: providerId, failure, message: `${providerId} ${failure}` }
    }
  }

  const deepseekKey = env.DEEPSEEK_API_KEY?.trim()
  if (deepseekKey) {
    const fetchImpl = input.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${deepseekKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const failure = classifyProviderStatus(res.status)
        attempts.push({ provider: "deepseek", ok: false, failure, status: res.status })
        lastFailure = { provider: "deepseek", failure, message: `deepseek ${failure}` }
      } else {
        let json: DeepSeekCompletion | null = null
        try {
          json = (await res.json()) as DeepSeekCompletion
        } catch {
          json = null
        }
        const content = json?.choices?.[0]?.message?.content?.trim()
        if (!content) {
          attempts.push({ provider: "deepseek", ok: false, failure: "invalid_response", status: res.status })
          lastFailure = { provider: "deepseek", failure: "invalid_response", message: "deepseek invalid_response" }
        } else {
          attempts.push({ provider: "deepseek", ok: true })
          return { ok: true, provider: "deepseek", model: json?.model ?? "deepseek-chat", content, attempts }
        }
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError"
      const failure: ProviderFailureKind = aborted ? "timeout" : "unavailable"
      attempts.push({ provider: "deepseek", ok: false, failure })
      lastFailure = { provider: "deepseek", failure, message: `deepseek ${failure}` }
    } finally {
      clearTimeout(timer)
    }
  }

  if (lastFailure) return { ok: false, ...lastFailure, attempts }
  return {
    ok: false,
    provider: "openrouter",
    failure: "not_configured",
    message: "No clinical AI provider configured (OPENROUTER_API_KEY or DEEPSEEK_API_KEY)",
    attempts,
  }
}
