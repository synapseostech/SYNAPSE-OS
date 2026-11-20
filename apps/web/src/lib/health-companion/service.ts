import { CLINICAL_AI_POLICIES } from "../ai/clinical-ai-gateway"
import {
  applyConsent,
  CONSENT_CATEGORIES,
  EMPTY_CONTEXT,
  formatContext,
  mergeContexts,
  NO_CONSENT,
  sanitiseDeviceContext,
  type CompanionConsent,
  type CompanionContext,
} from "./context"
import { buildSystemPrompt, COMPANION_PROMPT_VERSION } from "./prompt"
import type { CompanionChatMessage, CompanionProvider } from "./provider"
import {
  blockedOutputReply,
  detectRedFlags,
  doseRefusalReply,
  emergencyReply,
  guardModelOutput,
  isDoseChangeRequest,
  medicationNamesFrom,
  normaliseLanguage,
  UGANDA_EMERGENCY_NUMBERS,
  type CompanionLanguage,
  type RedFlagCategory,
} from "./safety"

export type SafetyKind = "none" | "emergency" | "dose_refusal" | "output_blocked" | "provider_unavailable"

export type StoredMessage = {
  id: string
  conversationId: string
  role: "user" | "assistant"
  content: string
  safetyKind: SafetyKind
  createdAt: string
}

export type ConversationSummary = { id: string; title: string; language: CompanionLanguage; updatedAt: string }

/** Persistence boundary. Every method is scoped by the session user id. */
export interface CompanionStore {
  getConsent(userId: string): Promise<CompanionConsent>
  saveConsent(userId: string, consent: CompanionConsent): Promise<void>
  loadRecordContext(userId: string): Promise<CompanionContext>
  /** Atomically takes one unit; returns the new count or null when exhausted. */
  takeQuota(quotaKey: string, limit: number): Promise<number | null>
  usageToday(quotaKey: string): Promise<number>
  getConversation(userId: string, conversationId: string): Promise<ConversationSummary | null>
  createConversation(userId: string, input: { title: string; language: CompanionLanguage }): Promise<string>
  listConversations(userId: string): Promise<ConversationSummary[]>
  listMessages(userId: string, conversationId: string, limit?: number): Promise<StoredMessage[]>
  appendMessages(
    userId: string,
    conversationId: string,
    rows: Array<{ role: "user" | "assistant"; content: string; safetyKind: SafetyKind; provider?: string; model?: string }>,
  ): Promise<void>
  deleteConversation(userId: string, conversationId: string): Promise<boolean>
  deleteAllConversations(userId: string): Promise<number>
}

export type CompanionDeps = {
  store: CompanionStore
  provider: CompanionProvider
  env?: NodeJS.Dict<string>
  now?: () => Date
  /** Short-window burst limiter (Upstash in production). */
  burstCheck?: (userId: string) => Promise<boolean>
}

/** Quota row for the whole deployment, so one free key is never exhausted by a few users. */
export const GLOBAL_QUOTA_KEY = "00000000-0000-0000-0000-000000000000"
export const MAX_MESSAGE_LENGTH = 2000
const HISTORY_TURNS = 8

export function companionLimits(env: NodeJS.Dict<string> = process.env) {
  const num = (value: string | undefined, fallback: number) => {
    const n = Number.parseInt(value ?? "", 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    perUserDaily: num(env.HEALTH_COMPANION_DAILY_LIMIT, 15),
    globalDaily: num(env.HEALTH_COMPANION_GLOBAL_DAILY_LIMIT, 250),
  }
}

export type CompanionResult = { status: number; body: Record<string, unknown> }

const UNAVAILABLE: Record<CompanionLanguage, { busy: string; down: string }> = {
  en: {
    busy: "The companion has reached its free daily limit. Please try again tomorrow. If you feel unwell, contact a health worker; in an emergency call 112 or 999.",
    down: "The companion can't answer right now. Please try again shortly. If you feel unwell, contact a health worker; in an emergency call 112 or 999.",
  },
  sw: {
    busy: "Msaidizi amefikia kikomo cha bure cha leo. Tafadhali jaribu kesho. Ukijisikia vibaya, wasiliana na mhudumu wa afya; kwa dharura piga 112 au 999.",
    down: "Msaidizi hawezi kujibu sasa. Tafadhali jaribu tena baadaye. Kwa dharura piga 112 au 999.",
  },
  lg: {
    busy: "Omuyambi atuuse ku kkomo lya leero. Gezaako enkya. Bw'owulira obubi, tuukirira omusawo; mu bw'amangu kuba ku 112 oba 999.",
    down: "Omuyambi tasobola kuddamu kati. Gezaako oluvannyuma. Mu bw'amangu kuba ku 112 oba 999.",
  },
}

function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim()
  return line.length > 60 ? `${line.slice(0, 57)}...` : line || "Conversation"
}

export async function sendCompanionMessage(
  userId: string,
  input: { message?: unknown; conversationId?: unknown; language?: unknown; deviceContext?: unknown },
  deps: CompanionDeps,
): Promise<CompanionResult> {
  const env = deps.env ?? process.env
  const message = typeof input.message === "string" ? input.message.trim() : ""
  if (!message) return { status: 400, body: { error: "message_required" } }
  if (message.length > MAX_MESSAGE_LENGTH) return { status: 400, body: { error: "message_too_long", max: MAX_MESSAGE_LENGTH } }
  const language = normaliseLanguage(input.language)

  let conversationId: string | null = null
  if (typeof input.conversationId === "string" && input.conversationId) {
    const existing = await deps.store.getConversation(userId, input.conversationId)
    // Another user's conversation id looks exactly like a missing one.
    if (!existing) return { status: 404, body: { error: "conversation_not_found" } }
    conversationId = existing.id
  }

  const respond = async (
    reply: string,
    safetyKind: SafetyKind,
    extra: Record<string, unknown> = {},
    meta: { provider?: string; model?: string } = {},
  ): Promise<CompanionResult> => {
    conversationId ??= await deps.store.createConversation(userId, { title: titleFrom(message), language })
    await deps.store.appendMessages(userId, conversationId, [
      { role: "user", content: message, safetyKind: "none" },
      { role: "assistant", content: reply, safetyKind, ...meta },
    ])
    return {
      status: 200,
      body: { conversationId, reply, safetyKind, advisory: true, promptVersion: COMPANION_PROMPT_VERSION, ...extra },
    }
  }

  // 1. Emergencies are answered first, always, without the model or a quota.
  const flags = detectRedFlags(message)
  if (flags.emergency) {
    return respond(emergencyReply(language, flags.categories), "emergency", {
      redFlags: flags.categories satisfies RedFlagCategory[],
      emergencyNumbers: UGANDA_EMERGENCY_NUMBERS,
    })
  }

  // 2. Dose changes are refused deterministically. Medicine names come from the
  // user's own record (not sent anywhere) so "double my metformin" is caught too.
  const consent = await deps.store.getConsent(userId)
  const recordContext = await deps.store.loadRecordContext(userId).catch(() => EMPTY_CONTEXT)
  const deviceContext = sanitiseDeviceContext(input.deviceContext)
  const medicationNames = medicationNamesFrom([...recordContext.medications, ...deviceContext.medications])
  if (isDoseChangeRequest(message, medicationNames)) return respond(doseRefusalReply(language), "dose_refusal")

  // 3. The user must have accepted the "not a doctor" terms before the model is used.
  if (!consent.acceptedTermsAt) return { status: 412, body: { error: "terms_not_accepted" } }

  if (deps.burstCheck && !(await deps.burstCheck(userId))) {
    return { status: 429, body: { error: "slow_down", retryAfterSeconds: 60 } }
  }

  const limits = companionLimits(env)
  if (limits.perUserDaily === 0) return { status: 429, body: { error: "daily_limit_reached", remaining: 0 } }
  const globalCount = await deps.store.takeQuota(GLOBAL_QUOTA_KEY, limits.globalDaily)
  if (globalCount === null) return respond(UNAVAILABLE[language].busy, "provider_unavailable", { remaining: 0 })
  const used = await deps.store.takeQuota(userId, limits.perUserDaily)
  if (used === null) {
    return { status: 429, body: { error: "daily_limit_reached", remaining: 0, limit: limits.perUserDaily } }
  }
  const remaining = Math.max(0, limits.perUserDaily - used)

  // 4. Only consented categories, only this user's rows.
  const context = applyConsent(mergeContexts(recordContext, deviceContext), consent)
  const contextBlock = formatContext(context)

  const history = (conversationId ? await deps.store.listMessages(userId, conversationId, HISTORY_TURNS) : []).filter(
    (m) => m.safetyKind === "none",
  )
  const messages: CompanionChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({ language, contextBlock, today: (deps.now?.() ?? new Date()).toISOString().slice(0, 10) }),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ]

  const completion = await deps.provider.complete({ messages, timeoutMs: CLINICAL_AI_POLICIES.health_coach.timeoutMs })
  if (!completion.ok) {
    const text = completion.failure === "rate_limited" ? UNAVAILABLE[language].busy : UNAVAILABLE[language].down
    return respond(text, "provider_unavailable", { remaining, failure: completion.failure }, { provider: completion.provider })
  }

  // 5. Output guard: doses may only echo what is already on the user's record.
  const guard = guardModelOutput(completion.content, `${contextBlock}\n${message}`)
  if (!guard.ok) {
    return respond(blockedOutputReply(language), "output_blocked", { remaining }, {
      provider: completion.provider,
      model: completion.model,
    })
  }

  return respond(completion.content, "none", { remaining, provider: completion.provider, model: completion.model }, {
    provider: completion.provider,
    model: completion.model,
  })
}

export async function readCompanionState(userId: string, deps: CompanionDeps, conversationId?: string | null) {
  const env = deps.env ?? process.env
  const limits = companionLimits(env)
  const [consent, conversations, used] = await Promise.all([
    deps.store.getConsent(userId),
    deps.store.listConversations(userId),
    deps.store.usageToday(userId),
  ])
  let messages: StoredMessage[] = []
  if (conversationId) {
    const convo = await deps.store.getConversation(userId, conversationId)
    if (!convo) return { status: 404, body: { error: "conversation_not_found" } }
    messages = await deps.store.listMessages(userId, conversationId, 200)
  }
  return {
    status: 200,
    body: {
      consent,
      conversations,
      messages,
      quota: { limit: limits.perUserDaily, used, remaining: Math.max(0, limits.perUserDaily - used) },
      providerConfigured: deps.provider.id !== "none",
      emergencyNumbers: UGANDA_EMERGENCY_NUMBERS,
      promptVersion: COMPANION_PROMPT_VERSION,
    },
  }
}

export function parseConsent(input: unknown, now: Date): CompanionConsent | null {
  if (!input || typeof input !== "object") return null
  const raw = input as Record<string, unknown>
  const consent: CompanionConsent = { ...NO_CONSENT }
  for (const category of CONSENT_CATEGORIES) consent[category] = raw[category] === true
  consent.acceptedTermsAt = raw.acceptTerms === true ? now.toISOString() : null
  return consent
}
