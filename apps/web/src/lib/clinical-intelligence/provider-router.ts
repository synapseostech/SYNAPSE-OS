import {
  completeOpenRouterChat,
  isOpenRouterConfigured,
  resolveOpenRouterModels,
} from "../ai/openrouter"
import type { ClinicalProviderId } from "./schemas"

export type ProviderChatResult =
  | { ok: true; provider: ClinicalProviderId; model: string; content: string }
  | { ok: false; provider: ClinicalProviderId; message: string }

const NVIDIA_OPENROUTER_MODELS = [
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
]

/**
 * Prefer OpenRouter (Google free models + optional NVIDIA via OpenRouter),
 * then direct DeepSeek if configured. forceMock never calls a live provider.
 */
export async function routeClinicalProvider(input: {
  system: string
  user: string
  forceMock?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}): Promise<ProviderChatResult> {
  const env = input.env ?? process.env
  if (input.forceMock || env.CLINICAL_INTELLIGENCE_FORCE_MOCK === "1") {
    return {
      ok: true,
      provider: "mock",
      model: "mock-clinical-v1",
      content: JSON.stringify({
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
      }),
    }
  }

  if (isOpenRouterConfigured(env)) {
    const preferNvidia = (env.CLINICAL_AI_PROVIDER ?? "").toLowerCase() === "nvidia"
    const models = preferNvidia
      ? [...NVIDIA_OPENROUTER_MODELS, ...resolveOpenRouterModels(env)]
      : resolveOpenRouterModels(env)
    const apiKey = env.OPENROUTER_API_KEY?.trim()
    if (!apiKey) {
      return { ok: false, provider: "openrouter", message: "OPENROUTER_API_KEY missing" }
    }
    const result = await completeOpenRouterChat({
      apiKey,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      models,
      temperature: 0.2,
      jsonMode: true,
      timeoutMs: 20_000,
      fetchImpl: input.fetchImpl,
      title: "Synapse Clinical Intelligence Wave 1",
    })
    if (result.ok) {
      return {
        ok: true,
        provider: preferNvidia ? "nvidia" : "openrouter",
        model: result.model,
        content: result.content,
      }
    }
  }

  const deepseekKey = env.DEEPSEEK_API_KEY?.trim()
  if (deepseekKey) {
    try {
      const fetchImpl = input.fetchImpl ?? fetch
      const res = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${deepseekKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.2,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
      })
      if (!res.ok) {
        return { ok: false, provider: "deepseek", message: `DeepSeek HTTP ${res.status}` }
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        model?: string
      }
      const content = json.choices?.[0]?.message?.content?.trim()
      if (!content) return { ok: false, provider: "deepseek", message: "empty DeepSeek content" }
      return { ok: true, provider: "deepseek", model: json.model ?? "deepseek-chat", content }
    } catch (error) {
      return {
        ok: false,
        provider: "deepseek",
        message: error instanceof Error ? error.message : "DeepSeek failed",
      }
    }
  }

  return {
    ok: false,
    provider: "openrouter",
    message: "No clinical AI provider configured (OPENROUTER_API_KEY or DEEPSEEK_API_KEY)",
  }
}
