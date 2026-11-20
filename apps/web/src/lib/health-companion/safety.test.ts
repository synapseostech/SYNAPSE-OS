import { describe, expect, it } from "vitest"
import {
  detectRedFlags,
  emergencyReply,
  guardModelOutput,
  isDoseChangeRequest,
  doseRefusalReply,
  UGANDA_EMERGENCY_NUMBERS,
} from "./safety"

describe("red-flag detection", () => {
  const emergencies: Array<[string, string]> = [
    ["I have crushing chest pain and my left arm is numb", "cardiac"],
    ["My father can't breathe properly", "breathing"],
    ["her face is drooping and she has slurred speech", "stroke"],
    ["my son had a seizure this morning", "collapse_seizure"],
    ["I am bleeding heavily after giving birth", "severe_bleeding"],
    ["I want to kill myself", "self_harm"],
    ["I'm pregnant and bleeding", "pregnancy"],
    ["my baby cannot breastfeed and is very sleepy", "child_danger"],
    ["my child drank paraffin", "poisoning"],
    ["my throat is swelling after the injection", "anaphylaxis"],
    ["fever and a stiff neck since yesterday", "meningitis"],
    ["I was bitten by a snake in the garden", "snake_bite"],
    // Swahili
    ["nina maumivu ya kifua", "cardiac"],
    ["mtoto ana degedege", "collapse_seizure"],
    ["nataka kujiua", "self_harm"],
    // Luganda
    ["sisobola kussa bulungi", "breathing"],
    ["njagala okwetta", "self_harm"],
  ]
  it.each(emergencies)("flags %s", (text, category) => {
    const result = detectRedFlags(text)
    expect(result.emergency).toBe(true)
    expect(result.categories).toContain(category)
  })

  it.each([
    "What does HbA1c mean?",
    "Give me a healthy breakfast idea with matooke",
    "How can I lower my stroke risk with diet?",
    "When is my next appointment?",
    "Why do I take metformin with food?",
  ])("does not flag everyday question: %s", (text) => {
    expect(detectRedFlags(text).emergency).toBe(false)
  })

  it("emergency replies name Uganda emergency numbers in every language", () => {
    for (const lang of ["en", "sw", "lg"] as const) {
      const reply = emergencyReply(lang, ["cardiac"])
      expect(reply).toContain("112")
      expect(reply).toContain("999")
    }
    expect(UGANDA_EMERGENCY_NUMBERS.map((n) => n.number)).toEqual(["112", "999", "116"])
  })
})

describe("dose-change refusal", () => {
  it.each([
    "Can I double my metformin dose?",
    "Should I stop taking my blood pressure pills?",
    "how many mg of paracetamol should i take",
    "can I take an extra tablet tonight",
    "I want to reduce my insulin",
    "nipunguze dawa?",
    "Make my dose higher please",
  ])("refuses %s", (text) => {
    expect(isDoseChangeRequest(text)).toBe(true)
  })

  it.each(["What is metformin for?", "Why do I take amlodipine in the morning?", "Remind me what my medicines are"])(
    "allows explanation: %s",
    (text) => expect(isDoseChangeRequest(text)).toBe(false),
  )

  it("catches a named medicine from the user's record, but not questions about it", () => {
    expect(isDoseChangeRequest("can I double my metformin?", ["metformin"])).toBe(true)
    expect(isDoseChangeRequest("I want to skip amlodipine today", ["amlodipine"])).toBe(true)
    expect(isDoseChangeRequest("tell me more about metformin", ["metformin"])).toBe(false)
    expect(isDoseChangeRequest("what is metformin for?", ["metformin"])).toBe(false)
  })

  it("refusal points to a clinician and never contains a dose", () => {
    const reply = doseRefusalReply("en")
    expect(reply).toMatch(/doctor|pharmacist/)
    expect(reply).not.toMatch(/\d+\s?mg/)
  })
})

describe("output guard", () => {
  const record = "Medications on record:\n- Metformin 500mg twice daily"
  it("allows restating a dose already on the record", () => {
    expect(guardModelOutput("You take metformin 500 mg twice a day with meals.", record)).toEqual({ ok: true })
  })
  it("blocks a dose that is not on the record", () => {
    expect(guardModelOutput("Take 1000 mg instead.", record)).toEqual({ ok: false, reason: "new_dose" })
  })
  it("blocks change directives but allows 'don't stop' advice", () => {
    expect(guardModelOutput("You should increase your medication this week.", record).ok).toBe(false)
    expect(guardModelOutput("Don't stop taking your medicine without talking to your doctor.", record).ok).toBe(true)
  })
  it("blocks diagnosis assertions", () => {
    expect(guardModelOutput("You most likely have malaria.", "")).toEqual({ ok: false, reason: "diagnosis" })
    expect(guardModelOutput("Malaria often causes fever; a test at a clinic can check.", "").ok).toBe(true)
  })
})
