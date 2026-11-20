import { describe, expect, it } from "vitest"
import { createGroqProvider, GROQ_CHAT_URL, resolveCompanionProvider, resolveGroqModels } from "./provider"

function fakeFetch(statuses: number[], content = "hello") {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") })
    const status = statuses[calls.length - 1] ?? 200
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content } }] }), { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe("companion provider abstraction", () => {
  it("is not configured without a server key, so nothing is called", async () => {
    const provider = resolveCompanionProvider({})
    expect(provider.id).toBe("none")
    expect(await provider.complete({ messages: [], timeoutMs: 10 })).toMatchObject({ ok: false, failure: "not_configured" })
  })

  it("refuses the mock provider in production", () => {
    expect(resolveCompanionProvider({ HEALTH_COMPANION_PROVIDER: "mock", VERCEL_ENV: "production" }).id).toBe("none")
    expect(resolveCompanionProvider({ HEALTH_COMPANION_PROVIDER: "mock" }).id).toBe("mock")
  })

  it("uses Groq with the server key and falls through models on 429", async () => {
    const f = fakeFetch([429, 200])
    const provider = resolveCompanionProvider({ GROQ_API_KEY: "gsk_test" }, f.impl)
    expect(provider.id).toBe("groq")
    const res = await provider.complete({ messages: [{ role: "user", content: "hi" }], timeoutMs: 1000 })
    expect(res).toMatchObject({ ok: true, provider: "groq", content: "hello" })
    expect(f.calls).toHaveLength(2)
    expect(f.calls[0].url).toBe(GROQ_CHAT_URL)
    expect(f.calls[0].auth).toBe("Bearer gsk_test")
    expect(f.calls[0].body.model).not.toBe(f.calls[1].body.model)
  })

  it("stops on an auth failure instead of trying every model", async () => {
    const f = fakeFetch([401, 200])
    const res = await createGroqProvider({ apiKey: "bad", models: ["a", "b"], fetchImpl: f.impl }).complete({ messages: [], timeoutMs: 1000 })
    expect(res).toMatchObject({ ok: false, failure: "auth" })
    expect(f.calls).toHaveLength(1)
  })

  it("lets the owner pin a model via env", () => {
    expect(resolveGroqModels({ GROQ_MODEL: "custom/model" })[0]).toBe("custom/model")
  })
})
