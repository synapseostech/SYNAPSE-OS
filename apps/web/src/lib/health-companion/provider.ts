/**
 * Provider abstraction for the health companion. The route only knows
 * `CompanionProvider`; swapping Groq for another OpenAI-compatible provider is
 * a new entry in `resolveCompanionProvider`, not a route change.
 *
 * Keys live only in server env (GROQ_API_KEY on Vercel). Nothing here is
 * bundled into the APK or the browser.
 */

export type CompanionChatMessage = { role: "system" | "user" | "assistant"; content: string }

export type CompanionProviderFailure = "not_configured" | "rate_limited" | "auth" | "timeout" | "unavailable" | "invalid_response"

export type CompanionCompletion =
  | { ok: true; provider: string; model: string; content: string }
  | { ok: false; provider: string; failure: CompanionProviderFailure; status?: number }

export interface CompanionProvider {
  readonly id: string
  complete(input: { messages: CompanionChatMessage[]; timeoutMs: number }): Promise<CompanionCompletion>
}

export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

/**
 * Free-plan Groq models, each with its own daily token pool (gpt-oss-120b:
 * 30 RPM, 1K RPD, 8K TPM, 200K TPD at the time of writing). Falling through
 * them on 429 spreads one shared key across several pools.
 */
export const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"] as const

export function resolveGroqModels(env: NodeJS.Dict<string> = process.env): string[] {
  const pinned = env.GROQ_MODEL?.trim()
  const extra = (env.GROQ_FALLBACK_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean)
  return [...new Set([...(pinned ? [pinned] : []), ...DEFAULT_GROQ_MODELS, ...extra])].slice(0, 4)
}

function classify(status: number): CompanionProviderFailure {
  if (status === 429) return "rate_limited"
  if (status === 401 || status === 403) return "auth"
  if (status === 408 || status === 504) return "timeout"
  return "unavailable"
}

type ChatCompletionJson = { model?: string; choices?: Array<{ message?: { content?: string | null } }> }

export function createGroqProvider(options: {
  apiKey: string
  models: string[]
  fetchImpl?: typeof fetch
  maxTokens?: number
}): CompanionProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    id: "groq",
    async complete({ messages, timeoutMs }) {
      let last: CompanionCompletion = { ok: false, provider: "groq", failure: "unavailable" }
      for (const model of options.models) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetchImpl(GROQ_CHAT_URL, {
            method: "POST",
            headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model,
              messages,
              temperature: 0.3,
              max_completion_tokens: options.maxTokens ?? 700,
              ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
            }),
            signal: controller.signal,
          })
          if (!res.ok) {
            last = { ok: false, provider: "groq", failure: classify(res.status), status: res.status }
            // A rejected key will be rejected for every model; stop early.
            if (last.failure === "auth") return last
            continue
          }
          const json = (await res.json().catch(() => null)) as ChatCompletionJson | null
          const content = json?.choices?.[0]?.message?.content?.trim()
          if (!content) {
            last = { ok: false, provider: "groq", failure: "invalid_response", status: res.status }
            continue
          }
          return { ok: true, provider: "groq", model: json?.model ?? model, content }
        } catch (error) {
          const aborted = error instanceof Error && error.name === "AbortError"
          last = { ok: false, provider: "groq", failure: aborted ? "timeout" : "unavailable" }
        } finally {
          clearTimeout(timer)
        }
      }
      return last
    },
  }
}

/** Canned provider for local development and tests. Refused in production. */
export function createMockProvider(reply = "This is a sample companion reply for testing. I am not a doctor."): CompanionProvider {
  return {
    id: "mock",
    async complete() {
      return { ok: true, provider: "mock", model: "mock-companion-v1", content: reply }
    },
  }
}

const notConfigured: CompanionProvider = {
  id: "none",
  async complete() {
    return { ok: false, provider: "none", failure: "not_configured" }
  },
}

export function resolveCompanionProvider(
  env: NodeJS.Dict<string> = process.env,
  fetchImpl?: typeof fetch,
): CompanionProvider {
  const choice = (env.HEALTH_COMPANION_PROVIDER ?? "groq").trim().toLowerCase()
  if (choice === "mock") {
    return env.VERCEL_ENV === "production" ? notConfigured : createMockProvider()
  }
  const apiKey = env.GROQ_API_KEY?.trim()
  if (!apiKey) return notConfigured
  return createGroqProvider({ apiKey, models: resolveGroqModels(env), fetchImpl })
}
