import { describe, expect, it } from "vitest"
import { ICD11_SEED_CACHE } from "@synapse/interop"
import { isKnownPathwayId, parseModelAdvice, verifyIcd11Hints } from "./model-output"
import { parseConfidence } from "./model-output"

describe("model output validation", () => {
  it("rejects invented, truncated and prefix ICD-11 codes", () => {
    const r = verifyIcd11Hints(["1G40", "1g40", "1G4", "1", "", "XX00", "1G40.ZZZZZ"])
    expect(r.verified.map((c) => c.stemCode)).toEqual(["1G40"])
    expect(r.rejected).toBe(5)
  })

  it("every stem in the trusted cache verifies (pattern does not reject real codes)", () => {
    const r = verifyIcd11Hints(ICD11_SEED_CACHE.map((e) => e.stemCode))
    expect(r.rejected).toBe(0)
  })

  it("confidence: NaN/garbage → null, out-of-range clamped", () => {
    expect(parseConfidence("abc")).toBeNull()
    expect(parseConfidence(Number.NaN)).toBeNull()
    expect(parseConfidence(7)).toBe(1)
    expect(parseConfidence(-1)).toBe(0)
    expect(parseConfidence("0.3")).toBe(0.3)
  })

  it("requires a recommendation string and bounds list sizes", () => {
    expect(parseModelAdvice({})).toBeNull()
    expect(parseModelAdvice({ recommendation: 42 })).toBeNull()
    const parsed = parseModelAdvice({
      recommendation: "x".repeat(5000),
      supportingEvidence: Array.from({ length: 40 }, (_, i) => `e${i}`).concat([1 as unknown as string]),
      cannotMiss: "yes",
    })
    expect(parsed?.recommendation.length).toBe(1000)
    expect(parsed?.supportingEvidence.length).toBe(12)
    expect(parsed?.cannotMiss).toBeNull()
  })

  it("only catalog pathway ids are accepted", () => {
    expect(isKnownPathwayId("pathway.adult-sepsis")).toBe(true)
    expect(isKnownPathwayId("pathway.made-up")).toBe(false)
    expect(parseModelAdvice({ recommendation: "r", suggestedPathwayId: "pathway.made-up" })?.suggestedPathwayId).toBeNull()
  })
})
