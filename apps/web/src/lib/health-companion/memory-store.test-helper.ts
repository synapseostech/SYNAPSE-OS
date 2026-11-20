import { EMPTY_CONTEXT, NO_CONSENT, type CompanionConsent, type CompanionContext } from "./context"
import type { CompanionStore, ConversationSummary, StoredMessage } from "./service"

/** In-memory CompanionStore with the same per-user scoping as the Supabase one. */
export function createMemoryStore(seed: { records?: Record<string, CompanionContext> } = {}) {
  const consents = new Map<string, CompanionConsent>()
  const conversations: Array<ConversationSummary & { userId: string }> = []
  const messages: Array<StoredMessage & { userId: string }> = []
  const usage = new Map<string, number>()
  let seq = 0
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`
  const recordReads: string[] = []

  const store: CompanionStore = {
    async getConsent(userId) {
      return consents.get(userId) ?? { ...NO_CONSENT }
    },
    async saveConsent(userId, consent) {
      consents.set(userId, consent)
    },
    async loadRecordContext(userId) {
      recordReads.push(userId)
      return seed.records?.[userId] ?? EMPTY_CONTEXT
    },
    async takeQuota(key, limit) {
      const used = usage.get(key) ?? 0
      if (used >= limit) return null
      usage.set(key, used + 1)
      return used + 1
    },
    async usageToday(key) {
      return usage.get(key) ?? 0
    },
    async getConversation(userId, conversationId) {
      const c = conversations.find((x) => x.id === conversationId && x.userId === userId)
      return c ? { id: c.id, title: c.title, language: c.language, updatedAt: c.updatedAt } : null
    },
    async createConversation(userId, input) {
      const c = { id: id(), userId, title: input.title, language: input.language, updatedAt: new Date().toISOString() }
      conversations.push(c)
      return c.id
    },
    async listConversations(userId) {
      return conversations.filter((c) => c.userId === userId)
    },
    async listMessages(userId, conversationId, limit = 200) {
      return messages.filter((m) => m.userId === userId && m.conversationId === conversationId).slice(-limit)
    },
    async appendMessages(userId, conversationId, rows) {
      for (const r of rows) {
        messages.push({ id: id(), userId, conversationId, role: r.role, content: r.content, safetyKind: r.safetyKind, createdAt: new Date().toISOString() })
      }
    },
    async deleteConversation(userId, conversationId) {
      const i = conversations.findIndex((c) => c.id === conversationId && c.userId === userId)
      if (i < 0) return false
      conversations.splice(i, 1)
      for (let j = messages.length - 1; j >= 0; j--) if (messages[j]?.conversationId === conversationId) messages.splice(j, 1)
      return true
    },
    async deleteAllConversations(userId) {
      const mine = conversations.filter((c) => c.userId === userId).map((c) => c.id)
      for (const cid of mine) await store.deleteConversation(userId, cid)
      return mine.length
    },
  }
  return { store, messages, conversations, usage, recordReads, consents }
}
