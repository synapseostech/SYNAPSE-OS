import { describe, expect, it } from "vitest"
import {
  summarizeContextForPrompt,
  CLINICAL_INTELLIGENCE_WAVE1_FLAG,
  adviseClinical,
  buildClinicalContext,
  clinicalIntelligenceDisabledResponse,
  isClinicalIntelligenceWave1Enabled,
  recordClinicianOverride,
} from "./index"

describe("Clinical Intelligence Wave 1", () => {
  it("feature flag defaults OFF", () => {
    expect(isClinicalIntelligenceWave1Enabled({})).toBe(false)
    expect(isClinicalIntelligenceWave1Enabled({ [CLINICAL_INTELLIGENCE_WAVE1_FLAG]: "true" })).toBe(true)
    expect(clinicalIntelligenceDisabledResponse().code).toBe("CLINICAL_INTELLIGENCE_DISABLED")
  })

  it("builds tenant-scoped context and rejects empty complaint", () => {
    const packet = buildClinicalContext({
      tenantId: "t1",
      clinicianId: "c1",
      presentingComplaint: "fever and hypotension",
      vitals: { heart_rate: 120, bp_systolic: 85 },
    })
    expect(packet.tenantId).toBe("t1")
    expect(packet.presentingComplaint).toMatch(/fever/)
    expect(() =>
      buildClinicalContext({ tenantId: "t1", clinicianId: "c1", presentingComplaint: "  " }),
    ).toThrow(/presentingComplaint/)
  })

  it("mock advise returns advisory sepsis suggestion without live providers", async () => {
    const packet = buildClinicalContext({
      tenantId: "00000000-0000-4000-8000-000000000001",
      clinicianId: "00000000-0000-4000-8000-000000000002",
      presentingComplaint: "fever hypotension suspected sepsis",
      vitals: { heart_rate: 120, bp_systolic: 85 },
    })
    const advice = await adviseClinical({ packet, forceMock: true })
    expect(advice.ok).toBe(true)
    expect(advice.advisory).toBe(true)
    expect(advice.humanOverrideRequired).toBe(true)
    expect(advice.safety.canActivatePathway).toBe(false)
    expect(advice.safety.canPlaceOrder).toBe(false)
    expect(advice.provider).toBe("mock")
    expect(advice.suggestedPathwayIds.length + (advice.recommendation.suggestedPathwayId ? 1 : 0)).toBeGreaterThan(0)
    expect(advice.recommendation.suggestedPathwayId === "pathway.adult-sepsis" || advice.suggestedPathwayIds.includes("pathway.adult-sepsis")).toBe(true)
  })

  it("records clinician override decisions", () => {
    const rec = recordClinicianOverride({
      recommendationId: "r1",
      decision: "REJECT",
      clinicianId: "c1",
      reason: "Does not fit clinical picture",
    })
    expect(rec.decision).toBe("REJECT")
    expect(rec.recommendationId).toBe("r1")
    expect(rec.at).toBeTruthy()
  })

  it("history and examination free text are never included in the external provider prompt", () => {
    const packet = buildClinicalContext({
      tenantId: "t1",
      clinicianId: "c1",
      presentingComplaint: "fever",
      history: ["lives at <home address>"],
      examination: ["identifying exam note"],
    })
    const prompt = summarizeContextForPrompt(packet)
    expect(prompt).not.toMatch(/home address|identifying exam note/)
    expect(prompt).not.toMatch(/"tenantId"|"clinicianId"|"patientId"/)
  })
})
