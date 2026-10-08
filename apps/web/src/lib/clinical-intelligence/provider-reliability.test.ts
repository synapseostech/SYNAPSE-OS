import { describe, expect, it, vi } from "vitest"
import { adviseClinical, buildClinicalContext, routeClinicalProvider } from "./index"

const SYSTEM = "system"
const USER = "{}"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function openRouterOk(content: string) {
  return jsonResponse(200, { model: "google/test", choices: [{ message: { content } }] })
}

/** A fetch that never resolves until aborted — simulates a hung provider. */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("aborted")
      err.name = "AbortError"
      reject(err)
    })
  })

const OPENROUTER_ONLY = { OPENROUTER_API_KEY: "test-key" } as NodeJS.ProcessEnv
const DEEPSEEK_ONLY = { DEEPSEEK_API_KEY: "test-key" } as NodeJS.ProcessEnv
const BOTH = { OPENROUTER_API_KEY: "test-key", DEEPSEEK_API_KEY: "test-key" } as NodeJS.ProcessEnv

function packet() {
  return buildClinicalContext({
    tenantId: "00000000-0000-4000-8000-000000000001",
    clinicianId: "00000000-0000-4000-8000-000000000002",
    presentingComplaint: "fever and hypotension",
    vitals: { heart_rate: 124, bp_systolic: 84 },
  })
}

describe("clinical provider router reliability (mocked, no live providers)", () => {
  it("no provider configured → not_configured, no network", async () => {
    const fetchImpl = vi.fn()
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: {} as NodeJS.ProcessEnv, fetchImpl })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toBe("not_configured")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("forceMock never calls a provider even when keys exist", async () => {
    const fetchImpl = vi.fn()
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: BOTH, fetchImpl, forceMock: true })
    expect(r.ok && r.provider).toBe("mock")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("OpenRouter timeout is bounded and classified", async () => {
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: OPENROUTER_ONLY, fetchImpl: hangingFetch, timeoutMs: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toBe("timeout")
  })

  it("DeepSeek timeout is bounded (previously unbounded)", async () => {
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: DEEPSEEK_ONLY, fetchImpl: hangingFetch, timeoutMs: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.provider).toBe("deepseek")
      expect(r.failure).toBe("timeout")
    }
  })

  it("rate limit (429) is classified", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: { message: "rate limited" } }))
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: OPENROUTER_ONLY, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toBe("rate_limited")
  })

  it("provider unavailable (503) is classified", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: { message: "down" } }))
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: DEEPSEEK_ONLY, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toBe("unavailable")
  })

  it("falls back from a failing OpenRouter to DeepSeek and records attempts", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("openrouter")
        ? jsonResponse(429, { error: { message: "busy" } })
        : jsonResponse(200, { model: "deepseek-chat", choices: [{ message: { content: '{"recommendation":"x"}' } }] }),
    )
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: BOTH, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok && r.provider).toBe("deepseek")
    expect(r.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["openrouter", false],
      ["deepseek", true],
    ])
  })

  it("DeepSeek non-JSON body is invalid_response, not a crash", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }))
    const r = await routeClinicalProvider({ system: SYSTEM, user: USER, env: DEEPSEEK_ONLY, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure).toBe("invalid_response")
  })
})

describe("adviseClinical graceful degradation", () => {
  it("AI unavailable → degraded deterministic advisory, still advisory-only", async () => {
    const advice = await adviseClinical({ packet: packet(), env: {} as NodeJS.ProcessEnv })
    expect(advice.ok).toBe(true)
    expect(advice.degraded).toBe(true)
    expect(advice.degradedReason).toBe("not_configured")
    expect(advice.origin).toBe("ai_suggestion")
    expect(advice.clinicianDocumentation).toBe(false)
    expect(advice.safety.canPlaceOrder).toBe(false)
    expect(advice.icd11Candidates).toEqual([])
  })

  it("invalid JSON from the model → degraded, nothing from the model is used", async () => {
    const fetchImpl = vi.fn(async () => openRouterOk("I think it's sepsis, code 1G40"))
    const advice = await adviseClinical({ packet: packet(), env: OPENROUTER_ONLY, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(advice.degraded).toBe(true)
    expect(advice.degradedReason).toBe("invalid_model_output")
    expect(advice.provider).toBe("mock")
    expect(advice.icd11Candidates).toEqual([])
  })

  it("wrong-shape JSON (no recommendation) → degraded", async () => {
    const fetchImpl = vi.fn(async () => openRouterOk(JSON.stringify({ confidence: 0.9, icd11StemHints: ["1G40"] })))
    const advice = await adviseClinical({ packet: packet(), env: OPENROUTER_ONLY, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(advice.degradedReason).toBe("invalid_model_output")
    expect(advice.icd11Candidates).toEqual([])
  })

  it("valid model output: only exact trusted ICD-11 stems and catalog pathways survive", async () => {
    const fetchImpl = vi.fn(async () =>
      openRouterOk(
        JSON.stringify({
          recommendation: "Suspected sepsis",
          confidence: "not-a-number",
          cannotMiss: true,
          icd11StemHints: ["1G40", "1G4", "1", "ZZ99", "1G40.ZZZ", "DROP TABLE"],
          suggestedPathwayId: "pathway.invented-by-model",
        }),
      ),
    )
    const advice = await adviseClinical({ packet: packet(), env: OPENROUTER_ONLY, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(advice.degraded).toBe(false)
    expect(advice.provider).toBe("openrouter")
    expect(advice.icd11Candidates.map((c) => c.stemCode)).toEqual(["1G40"])
    expect(advice.icd11HintsRejected).toBe(5)
    expect(Number.isFinite(advice.recommendation.confidence)).toBe(true)
    expect(advice.recommendation.suggestedPathwayId).not.toBe("pathway.invented-by-model")
    expect(advice.provenance.sources.filter((s) => s.startsWith("icd11:"))).toEqual(["icd11:1G40"])
  })
})
