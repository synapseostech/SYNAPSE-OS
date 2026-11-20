import { describe, expect, it } from "vitest"
import { EMPTY_CONTEXT } from "./context"
import { createMemoryStore } from "./memory-store.test-helper"
import type { CompanionChatMessage, CompanionProvider } from "./provider"
import { GLOBAL_QUOTA_KEY, readCompanionState, sendCompanionMessage } from "./service"

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"

function spyProvider(reply = "Metformin helps your body use sugar. Take it with food as your clinic advised.") {
  const calls: CompanionChatMessage[][] = []
  const provider: CompanionProvider = {
    id: "spy",
    async complete({ messages }) {
      calls.push(messages)
      return { ok: true, provider: "spy", model: "spy-1", content: reply }
    },
  }
  return { provider, calls }
}

async function setup(opts: { reply?: string; consent?: Partial<Record<string, boolean>>; env?: Record<string, string> } = {}) {
  const mem = createMemoryStore({
    records: {
      [ALICE]: { ...EMPTY_CONTEXT, medications: ["Metformin 500mg twice daily"], labs: ["HbA1c: 7.9 % (reference 4-5.6)"], appointments: ["2026-12-01 clinic"] },
      [BOB]: { ...EMPTY_CONTEXT, medications: ["BOB-SECRET-DRUG 20mg"] },
    },
  })
  await mem.store.saveConsent(ALICE, {
    medications: true, appointments: false, readings: false, labs: true, wearables: false,
    acceptedTermsAt: "2026-11-19T00:00:00.000Z", ...opts.consent,
  })
  const spy = spyProvider(opts.reply)
  const deps = { store: mem.store, provider: spy.provider, env: opts.env ?? {} }
  return { mem, spy, deps }
}

describe("health companion governance", () => {
  it("answers a normal question with consented context only", async () => {
    const { spy, deps, mem } = await setup()
    const res = await sendCompanionMessage(ALICE, { message: "What is my metformin for?" }, deps)
    expect(res.status).toBe(200)
    expect(res.body.safetyKind).toBe("none")
    expect(res.body.advisory).toBe(true)
    const system = spy.calls[0][0].content
    expect(system).toContain("Metformin 500mg twice daily")
    expect(system).toContain("HbA1c")
    expect(system).not.toContain("2026-12-01 clinic") // appointments not consented
    expect(system).toMatch(/NOT a doctor/)
    expect(mem.messages).toHaveLength(2)
  })

  it("never reads or sends another user's record", async () => {
    const { spy, deps, mem } = await setup()
    await sendCompanionMessage(ALICE, { message: "List my medicines", userId: BOB, patientId: BOB } as never, deps)
    expect(mem.recordReads).toEqual([ALICE])
    expect(JSON.stringify(spy.calls)).not.toContain("BOB-SECRET-DRUG")
  })

  it("cannot continue another user's conversation", async () => {
    const { deps } = await setup()
    await deps.store.saveConsent(BOB, { medications: true, appointments: false, readings: false, labs: false, wearables: false, acceptedTermsAt: "x" })
    const bob = await sendCompanionMessage(BOB, { message: "hello" }, deps)
    const res = await sendCompanionMessage(ALICE, { message: "hi", conversationId: bob.body.conversationId }, deps)
    expect(res.status).toBe(404)
    const state = await readCompanionState(ALICE, deps, bob.body.conversationId as string)
    expect(state.status).toBe(404)
  })

  it("sends nothing from the record when no category is consented", async () => {
    const { spy, deps } = await setup({ consent: { medications: false, labs: false } })
    await sendCompanionMessage(ALICE, { message: "tips for sleep" }, deps)
    expect(spy.calls[0][0].content).not.toContain("Metformin")
  })

  it("drops device context for categories without consent", async () => {
    const { spy, deps } = await setup({ consent: { readings: false } })
    await sendCompanionMessage(ALICE, { message: "tips", deviceContext: { readings: ["BP 150/95 today"], medications: ["Amlodipine 5mg daily"] } }, deps)
    const system = spy.calls[0][0].content
    expect(system).not.toContain("150/95")
    expect(system).toContain("Amlodipine 5mg daily")
  })

  it("requires accepting the not-a-doctor terms before calling the model", async () => {
    const { spy, deps } = await setup({ consent: {} })
    await deps.store.saveConsent(ALICE, { medications: true, appointments: false, readings: false, labs: false, wearables: false, acceptedTermsAt: null })
    const res = await sendCompanionMessage(ALICE, { message: "hello" }, deps)
    expect(res.status).toBe(412)
    expect(spy.calls).toHaveLength(0)
  })

  it("answers emergencies without the model, without terms and without quota", async () => {
    const { spy, deps, mem } = await setup({ env: { HEALTH_COMPANION_DAILY_LIMIT: "0" } })
    await deps.store.saveConsent(ALICE, { medications: false, appointments: false, readings: false, labs: false, wearables: false, acceptedTermsAt: null })
    const res = await sendCompanionMessage(ALICE, { message: "I have severe chest pain", language: "sw" }, deps)
    expect(res.status).toBe(200)
    expect(res.body.safetyKind).toBe("emergency")
    expect(String(res.body.reply)).toContain("112")
    expect(spy.calls).toHaveLength(0)
    expect(mem.usage.size).toBe(0)
    expect(mem.messages.at(-1)?.safetyKind).toBe("emergency")
  })

  it("refuses dose changes without calling the model", async () => {
    const { spy, deps } = await setup()
    const res = await sendCompanionMessage(ALICE, { message: "Can I double my metformin?" }, deps)
    expect(res.body.safetyKind).toBe("dose_refusal")
    expect(spy.calls).toHaveLength(0)
  })

  it("replaces model output that prescribes a new dose", async () => {
    const { deps } = await setup({ reply: "Take 1000 mg of metformin from tomorrow." })
    const res = await sendCompanionMessage(ALICE, { message: "my sugar is high" }, deps)
    expect(res.body.safetyKind).toBe("output_blocked")
    expect(String(res.body.reply)).not.toContain("1000")
  })

  it("enforces the per-user daily limit", async () => {
    const { deps, spy } = await setup({ env: { HEALTH_COMPANION_DAILY_LIMIT: "2" } })
    expect((await sendCompanionMessage(ALICE, { message: "a" }, deps)).body.remaining).toBe(1)
    expect((await sendCompanionMessage(ALICE, { message: "b" }, deps)).body.remaining).toBe(0)
    const third = await sendCompanionMessage(ALICE, { message: "c" }, deps)
    expect(third.status).toBe(429)
    expect(spy.calls).toHaveLength(2)
  })

  it("enforces the deployment-wide ceiling so the free key is not exhausted", async () => {
    const { deps, spy, mem } = await setup({ env: { HEALTH_COMPANION_GLOBAL_DAILY_LIMIT: "1" } })
    await sendCompanionMessage(ALICE, { message: "a" }, deps)
    const res = await sendCompanionMessage(ALICE, { message: "b" }, deps)
    expect(res.body.safetyKind).toBe("provider_unavailable")
    expect(spy.calls).toHaveLength(1)
    expect(mem.usage.get(GLOBAL_QUOTA_KEY)).toBe(1)
  })

  it("deleting conversations does not reset the quota", async () => {
    const { deps, mem } = await setup({ env: { HEALTH_COMPANION_DAILY_LIMIT: "1" } })
    await sendCompanionMessage(ALICE, { message: "a" }, deps)
    expect(await deps.store.deleteAllConversations(ALICE)).toBe(1)
    expect(mem.messages).toHaveLength(0)
    expect((await sendCompanionMessage(ALICE, { message: "b" }, deps)).status).toBe(429)
  })

  it("degrades gracefully when the provider fails", async () => {
    const { deps } = await setup()
    deps.provider = { id: "groq", complete: async () => ({ ok: false, provider: "groq", failure: "rate_limited" }) }
    const res = await sendCompanionMessage(ALICE, { message: "hello" }, deps)
    expect(res.status).toBe(200)
    expect(res.body.safetyKind).toBe("provider_unavailable")
    expect(String(res.body.reply)).toContain("112")
  })

  it("rejects empty and oversized messages", async () => {
    const { deps } = await setup()
    expect((await sendCompanionMessage(ALICE, { message: "  " }, deps)).status).toBe(400)
    expect((await sendCompanionMessage(ALICE, { message: "x".repeat(2001) }, deps)).status).toBe(400)
  })

  it("asks the model to reply in the chosen language", async () => {
    const { deps, spy } = await setup()
    await sendCompanionMessage(ALICE, { message: "Habari, nisaidie kuhusu usingizi", language: "sw" }, deps)
    expect(spy.calls[0][0].content).toContain("Reply in Swahili")
  })
})
