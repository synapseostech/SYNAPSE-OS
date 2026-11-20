import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"

const h = vi.hoisted(() => ({
  tokens: {} as Record<string, string>,
  cookie: null as string | null,
  sessionValid: true,
  mem: null as null | ReturnType<typeof import("../../../../lib/health-companion/memory-store.test-helper").createMemoryStore>,
  providerCalls: 0,
}))

vi.mock("@synapse/auth", () => ({
  verifyToken: async (token: string) => (h.tokens[token] ? { sub: h.tokens[token] } : null),
  validateSession: async () => ({ valid: h.sessionValid }),
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (h.cookie ? { value: h.cookie } : undefined) }),
}))
vi.mock("../../../../lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true, remaining: 10 }),
  rateLimiters: { ai: null },
}))
vi.mock("../../../../lib/health-companion/supabase-store", () => ({
  createSupabaseCompanionStore: () => h.mem!.store,
}))
vi.mock("../../../../lib/health-companion/provider", async (orig) => ({
  ...(await orig<typeof import("../../../../lib/health-companion/provider")>()),
  resolveCompanionProvider: () => ({
    id: "spy",
    complete: async () => {
      h.providerCalls += 1
      return { ok: true, provider: "spy", model: "spy", content: "Here is some general information. I am not a doctor." }
    },
  }),
}))

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  return new NextRequest(`https://www.synapseos.tech${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

beforeEach(async () => {
  const { createMemoryStore } = await import("../../../../lib/health-companion/memory-store.test-helper")
  const { EMPTY_CONTEXT } = await import("../../../../lib/health-companion/context")
  h.mem = createMemoryStore({ records: { [BOB]: { ...EMPTY_CONTEXT, medications: ["BOB-ONLY 10mg"] } } })
  h.tokens = { "alice-token": ALICE, "bob-token": BOB }
  h.cookie = null
  h.sessionValid = true
  h.providerCalls = 0
})

describe("/api/health/companion", () => {
  it("rejects requests without a valid session", async () => {
    const { GET, POST, DELETE } = await import("./route")
    expect((await GET(req("GET", "/api/health/companion"))).status).toBe(401)
    expect((await POST(req("POST", "/api/health/companion", { body: { message: "hi" } }))).status).toBe(401)
    expect((await DELETE(req("DELETE", "/api/health/companion?all=1"))).status).toBe(401)
    h.sessionValid = false
    expect((await GET(req("GET", "/api/health/companion", { token: "alice-token" }))).status).toBe(401)
  })

  it("accepts the APK Bearer token and the web cookie", async () => {
    const { GET } = await import("./route")
    expect((await GET(req("GET", "/api/health/companion", { token: "alice-token" }))).status).toBe(200)
    h.cookie = "alice-token"
    const res = await GET(req("GET", "/api/health/companion"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")
  })

  it("consent, chat and delete round trip, scoped to the session user", async () => {
    const { GET, POST, DELETE } = await import("./route")
    const { PUT } = await import("./consent/route")

    const blocked = await POST(req("POST", "/api/health/companion", { token: "alice-token", body: { message: "hello" } }))
    expect(blocked.status).toBe(412)

    const consent = await PUT(req("PUT", "/api/health/companion/consent", { token: "alice-token", body: { acceptTerms: true, medications: true } }))
    expect(consent.status).toBe(200)

    // A body-supplied user id is ignored: Alice cannot read Bob's record.
    const sent = await POST(req("POST", "/api/health/companion", { token: "alice-token", body: { message: "what are my meds?", userId: BOB } }))
    const body = await sent.json()
    expect(sent.status).toBe(200)
    expect(body.advisory).toBe(true)
    expect(h.mem!.recordReads.every((id) => id === ALICE)).toBe(true)

    const bobView = await GET(req("GET", `/api/health/companion?conversationId=${body.conversationId}`, { token: "bob-token" }))
    expect(bobView.status).toBe(404)
    const bobDelete = await DELETE(req("DELETE", `/api/health/companion?conversationId=${body.conversationId}`, { token: "bob-token" }))
    expect(bobDelete.status).toBe(404)

    const aliceView = await (await GET(req("GET", `/api/health/companion?conversationId=${body.conversationId}`, { token: "alice-token" }))).json()
    expect(aliceView.messages).toHaveLength(2)
    expect(aliceView.quota.used).toBe(1)

    const del = await DELETE(req("DELETE", `/api/health/companion?conversationId=${body.conversationId}`, { token: "alice-token" }))
    expect(await del.json()).toEqual({ deleted: 1 })
    expect(h.mem!.messages).toHaveLength(0)
  })

  it("returns an emergency reply even before consent", async () => {
    const { POST } = await import("./route")
    const res = await POST(req("POST", "/api/health/companion", { token: "alice-token", body: { message: "my child had a seizure" } }))
    const body = await res.json()
    expect(body.safetyKind).toBe("emergency")
    expect(body.emergencyNumbers.map((n: { number: string }) => n.number)).toContain("112")
    expect(h.providerCalls).toBe(0)
  })

  it("rejects invalid json", async () => {
    const { POST } = await import("./route")
    const bad = new NextRequest("https://www.synapseos.tech/api/health/companion", {
      method: "POST",
      headers: { authorization: "Bearer alice-token" },
      body: "{",
    })
    expect((await POST(bad)).status).toBe(400)
  })
})
