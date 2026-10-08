import { describe, expect, it } from "vitest"
import { adviceErrorMessage, toAdviceView } from "./advice-view"

const base = {
  ok: true,
  advisory: true,
  provider: "openrouter",
  model: "google/test",
  degraded: false,
  degradedReason: null,
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

  it("cannot-miss and degraded states produce explicit warnings; pathway is advisory", () => {
    const v = toAdviceView({ ...base, degraded: true, degradedReason: "timeout" })!
    expect(v.warnings[0]).toMatch(/timed out.*rule-based fallback/)
    expect(v.warnings[1]).toMatch(/Cannot-miss/)
    expect(v.pathwayNote).toMatch(/advisory/)
    expect(v.sourceNote).toBe("Source: deterministic fallback")
  })

  it("rejects malformed payloads", () => {
    expect(toAdviceView({ ok: false })).toBeNull()
    expect(toAdviceView({ ok: true })).toBeNull()
  })

  it("maps HTTP failures to clinician-safe messages", () => {
    expect(adviceErrorMessage(503)).toMatch(/switched off/)
    expect(adviceErrorMessage(500)).toMatch(/Continue documenting as normal/)
  })
})
