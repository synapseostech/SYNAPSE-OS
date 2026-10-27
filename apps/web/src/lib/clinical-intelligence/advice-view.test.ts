import { describe, expect, it } from "vitest"
import { adviceErrorMessage, adviceUnavailableNotice, toAdviceView } from "./advice-view"

const base = {
  ok: true,
  advisory: true,
  provider: "openrouter",
  model: "google/test",
  degraded: false,
  degradedReason: null,
  availability: "available" as const,
  synthetic: false,
  recommendation: {
    id: "r1",
    recommendation: "Suspected sepsis",
    reasoningSummary: "Fever with hypotension",
    supportingEvidence: ["fever"],
    contradictingEvidence: ["no focal source"],
    missingInformation: ["lactate", "blood culture"],
    confidence: 0.42,
    cannotMiss: true,
    suggestedPathwayId: "pathway.adult-sepsis",
  },
  icd11Candidates: [
    { stemCode: "1G40", title: "Sepsis without septic shock", verified: true },
    { stemCode: "ZZ99", title: "bogus", verified: false },
  ],
  icd11HintsRejected: 2,
}

describe("advice view model", () => {
  it("labels AI output as a suggestion, never documentation", () => {
    const v = toAdviceView(base)!
    expect(v.label).toMatch(/AI suggestion — not part of the clinical record/)
    expect(v.confidenceText).toBe("Model confidence: 42%")
    expect(v.suggestedInvestigations).toEqual(["lactate", "blood culture"])
    expect(v.evidenceAgainst).toEqual(["no focal source"])
  })

  it("shows only verified ICD-11 candidates and reports dropped codes", () => {
    const v = toAdviceView(base)!
    expect(v.icd11).toEqual([{ code: "1G40", title: "Sepsis without septic shock" }])
    expect(v.icd11RejectedNote).toMatch(/2 ICD-11 code suggestions failed verification/)
  })

  it("cannot-miss produces an explicit warning; pathway is advisory; live source shown", () => {
    const v = toAdviceView(base)!
    expect(v.warnings).toHaveLength(1)
    expect(v.warnings[0]).toMatch(/Cannot-miss/)
    expect(v.pathwayNote).toMatch(/advisory/)
    expect(v.sourceNote).toBe("Source: openrouter · google/test")
    expect(adviceUnavailableNotice(base)).toBeNull()
  })

  it("AI unavailable → no suggestion rendered, no decision possible, clear continue-documenting notice", () => {
    const unavailable = {
      ...base,
      availability: "unavailable" as const,
      provider: "none",
      model: null,
      degraded: true,
      degradedReason: "timeout",
      recommendation: null,
      icd11Candidates: [],
    }
    expect(toAdviceView(unavailable)).toBeNull()
    expect(adviceUnavailableNotice(unavailable)).toMatch(/^AI unavailable — continue documenting normally\. The AI service timed out\./)
    expect(adviceUnavailableNotice({ ...unavailable, degradedReason: "mock_disallowed" })).toMatch(/not permitted/)
  })

  it("a degraded payload that still carries a recommendation is never shown as advice", () => {
    const legacyFallback = { ...base, degraded: true, degradedReason: "timeout" }
    expect(toAdviceView(legacyFallback)).toBeNull()
    expect(adviceUnavailableNotice(legacyFallback)).toMatch(/AI unavailable/)
  })

  it("synthetic (mock) output is labelled as test output, never as a model opinion", () => {
    const v = toAdviceView({ ...base, provider: "mock", model: "mock-clinical-v1", synthetic: true })!
    expect(v.warnings[0]).toMatch(/Synthetic test output.*Never use it for patient care/)
    expect(v.sourceNote).toBe("Source: mock provider (synthetic test output)")
  })

  it("rejects malformed payloads", () => {
    expect(toAdviceView({ ok: false })).toBeNull()
    expect(toAdviceView({ ok: true })).toBeNull()
  })

  it("maps HTTP failures to clinician-safe messages", () => {
    expect(adviceErrorMessage(503)).toMatch(/switched off/)
    expect(adviceErrorMessage(500)).toMatch(/Continue documenting as normal/)
    expect(adviceErrorMessage(409)).toMatch(/no AI suggestion/)
  })
})
