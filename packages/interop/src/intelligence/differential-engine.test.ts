import { describe, expect, it } from "vitest"
import {
  CONDITIONS,
  FINDINGS,
  INVESTIGATIONS,
  differentialFromConsultation,
  extractFindings,
  interpretQualitativeResult,
  investigationCodeFor,
  rankDifferentials,
  vitalFindings,
  type FindingId,
} from "./differential-engine"

const top = (r: ReturnType<typeof rankDifferentials>) => r.differentials[0]?.id
const ids = (r: ReturnType<typeof rankDifferentials>) => r.differentials.map((d) => d.id)

describe("knowledge base integrity", () => {
  it("every feature, red flag and requirement is a defined finding", () => {
    for (const c of CONDITIONS) {
      for (const [f] of c.features) expect(FINDINGS[f], `${c.id}.${f}`).toBeDefined()
      for (const f of [...c.requiresAny, ...(c.redFlags ?? [])]) expect(FINDINGS[f as FindingId], `${c.id}.${f}`).toBeDefined()
      for (const [code] of c.investigations) expect(INVESTIGATIONS[code], `${c.id}.${code}`).toBeDefined()
    }
  })

  it("condition ids are unique", () => {
    const seen = new Set(CONDITIONS.map((c) => c.id))
    expect(seen.size).toBe(CONDITIONS.length)
  })
})

describe("free text", () => {
  it("reads common Ugandan phrasing", () => {
    const f = extractFindings("Hotness of body for 3 days, joint pains and loss of appetite. Burning urine.")
    expect(f).toMatchObject({ fever: "present", myalgia: "present", anorexia: "present", dysuria: "present" })
  })

  it("records pertinent negatives", () => {
    const f = extractFindings("Fever and headache. No cough, denies diarrhoea; not vomiting")
    expect(f.fever).toBe("present")
    expect(f.cough).toBe("absent")
    expect(f.diarrhoea).toBe("absent")
    expect(f.vomiting).toBe("absent")
  })

  it("prefers the longer phrase", () => {
    const f = extractFindings("lower abdominal pain")
    expect(f.suprapubic_pain).toBe("present")
    expect(f.abdominal_pain).toBeUndefined()
  })
})

describe("vitals", () => {
  it("uses IMCI fast-breathing cut-offs for children", () => {
    expect(vitalFindings({ respiratoryRate: 45 }, { ageYears: 3 }).v_tachypnoea).toBe("present")
    expect(vitalFindings({ respiratoryRate: 45 }, { ageYears: 0.5 }).v_tachypnoea).toBe("absent")
    expect(vitalFindings({ respiratoryRate: 24 }, { ageYears: 30 }).v_tachypnoea).toBe("present")
  })

  it("flags fever, hypoxia, shock and hypertensive crisis", () => {
    const f = vitalFindings({ temperatureC: 39.4, spo2: 89, bpSystolic: 85, bpDiastolic: 50 })
    expect(f).toMatchObject({ v_fever: "present", v_high_fever: "present", v_hypoxia: "present", v_hypotension: "present", v_bp_high: "absent" })
    expect(vitalFindings({ bpSystolic: 190, bpDiastolic: 125 }).v_bp_crisis).toBe("present")
  })
})

describe("ranking common presentations", () => {
  it("fever, chills, headache, joint pains: malaria first, MRDT to confirm", () => {
    const r = differentialFromConsultation({ text: "fever with chills, headache and joint pains for 2 days", vitals: { temperatureC: 38.6 } })
    expect(top(r)).toBe("malaria")
    expect(r.differentials[0].icd11.code).toBe("1F40.Z")
    expect(r.differentials[0].investigations[0]).toMatchObject({ code: "MRDT", purpose: "confirm" })
    expect(r.differentials[0].likelihood).toBe("high")
  })

  it("fever with confusion: severe malaria is urgent and a danger sign shows", () => {
    const r = differentialFromConsultation({ text: "fever, confused and unable to stand", vitals: { temperatureC: 39 } })
    expect(ids(r).slice(0, 2)).toContain("severe_malaria")
    expect(r.differentials.find((d) => d.id === "severe_malaria")!.urgent).toBe(true)
    expect(r.dangerSigns.map((d) => d.id)).toContain("confusion")
  })

  it("cough 3 weeks, night sweats, weight loss: TB first, GeneXpert to confirm", () => {
    const r = differentialFromConsultation({ text: "cough for 3 weeks with night sweats and weight loss" })
    expect(top(r)).toBe("ptb")
    expect(r.differentials[0].investigations[0].code).toBe("GENEXPERT")
  })

  it("cough, fast breathing, crackles: pneumonia over common cold", () => {
    const r = differentialFromConsultation({ text: "cough and difficulty in breathing, crepitations right base", vitals: { respiratoryRate: 30, temperatureC: 38.2 } })
    expect(top(r)).toBe("pneumonia")
    expect(ids(r).indexOf("urti")).toBeGreaterThan(0)
  })

  it("runny nose and cough without fever: common cold", () => {
    const r = differentialFromConsultation({ text: "runny nose, sneezing and mild cough. No fever", vitals: { temperatureC: 36.8, respiratoryRate: 16 } })
    expect(top(r)).toBe("urti")
  })

  it("burning urine and frequency: UTI", () => {
    const r = differentialFromConsultation({ text: "burning urine and frequency, lower abdominal pain", context: { sex: "F", ageYears: 28 } })
    expect(top(r)).toBe("uti")
    expect(r.differentials[0].investigations.map((i) => i.code)).toContain("URINE")
  })

  it("diarrhoea and vomiting: gastroenteritis; bloody stool: dysentery", () => {
    expect(top(differentialFromConsultation({ text: "diarrhoea and vomiting since yesterday" }))).toBe("gastroenteritis")
    expect(top(differentialFromConsultation({ text: "bloody diarrhoea with abdominal pain" }))).toBe("dysentery")
  })

  it("fever, headache, stiff neck: meningitis is urgent", () => {
    const r = differentialFromConsultation({ text: "fever, severe headache, neck stiffness and photophobia", vitals: { temperatureC: 39.2 } })
    expect(top(r)).toBe("meningitis")
    expect(r.differentials[0].urgent).toBe(true)
  })

  it("missed period, lower abdominal pain, shock: ectopic pregnancy is urgent", () => {
    const r = differentialFromConsultation({
      text: "missed period, lower abdominal pain and pv bleeding",
      vitals: { bpSystolic: 82, heartRate: 124 },
      context: { sex: "F", ageYears: 26 },
    })
    expect(top(r)).toBe("ectopic")
    expect(r.differentials[0].urgent).toBe(true)
  })

  it("men are never offered ectopic pregnancy or PID", () => {
    const r = differentialFromConsultation({ text: "missed period lower abdominal pain vaginal discharge", context: { sex: "M", ageYears: 30 } })
    expect(ids(r)).not.toContain("ectopic")
    expect(ids(r)).not.toContain("pid")
  })

  it("pregnant with high BP and headache: pre-eclampsia, not essential hypertension", () => {
    const r = differentialFromConsultation({ text: "headache and blurred vision", vitals: { bpSystolic: 165, bpDiastolic: 112 }, context: { sex: "F", ageYears: 24, pregnant: true } })
    expect(top(r)).toBe("preeclampsia")
    expect(ids(r)).not.toContain("hypertension")
  })

  it("epigastric pain after NSAIDs: peptic ulcer / gastritis", () => {
    expect(top(differentialFromConsultation({ text: "epigastric pain, nausea, on diclofenac for back pain" }))).toBe("pud")
  })

  it("a pertinent negative lowers the score", () => {
    const withCough = rankDifferentials({ cough: "present", productive_cough: "present", crepitations: "present" })
    const coughNoCrackles = rankDifferentials({ cough: "present", productive_cough: "present", crepitations: "absent" })
    const p1 = withCough.differentials.find((d) => d.id === "pneumonia")!.score
    const p2 = coughNoCrackles.differentials.find((d) => d.id === "pneumonia")?.score ?? -99
    expect(p2).toBeLessThan(p1)
  })

  it("suggests questions that separate the leading diagnoses", () => {
    const r = differentialFromConsultation({ text: "fever" })
    expect(r.askNext.length).toBeGreaterThan(2)
    expect(r.askNext.every((q) => !q.id.startsWith("v_"))).toBe(true)
  })

  it("returns nothing for an empty note", () => {
    const r = differentialFromConsultation({ text: "" })
    expect(r.differentials).toEqual([])
    expect(r.findingCount).toBe(0)
  })

  it("relative shares add up to about 1", () => {
    const r = differentialFromConsultation({ text: "fever, cough, headache, joint pains, diarrhoea" })
    const sum = r.differentials.reduce((a, d) => a + d.relative, 0)
    expect(sum).toBeGreaterThan(0.97)
    expect(sum).toBeLessThan(1.03)
  })
})

describe("results close the loop", () => {
  const text = "fever with chills, headache and joint pains"
  it("a negative MRDT pushes malaria down and says why", () => {
    const before = differentialFromConsultation({ text })
    const after = differentialFromConsultation({ text, outcomes: [{ code: "MRDT", positive: false }] })
    const b = before.differentials.find((d) => d.id === "malaria")!
    const a = after.differentials.find((d) => d.id === "malaria")
    expect(a?.score ?? -99).toBeLessThan(b.score)
    expect(a?.against[0]?.label).toBe("Malaria RDT negative")
    expect(after.differentials[0]?.id).not.toBe("malaria")
  })

  it("a positive GeneXpert makes TB the clear leader", () => {
    const r = differentialFromConsultation({ text: "cough and fever", outcomes: [{ code: "GENEXPERT", positive: true }] })
    expect(r.differentials[0]?.id).toBe("ptb")
    expect(r.differentials[0]?.supporting[0]?.label).toBe("Sputum GeneXpert MTB/RIF positive")
  })

  it("reads qualitative results and leaves numbers alone", () => {
    expect(interpretQualitativeResult("Negative")).toBe(false)
    expect(interpretQualitativeResult("No parasites seen")).toBe(false)
    expect(interpretQualitativeResult("Non-reactive")).toBe(false)
    expect(interpretQualitativeResult("P. falciparum seen ++")).toBe(true)
    expect(interpretQualitativeResult("Reactive")).toBe(true)
    expect(interpretQualitativeResult("9.1")).toBeNull()
    expect(interpretQualitativeResult("12.5 g/dL")).toBeNull()
    expect(interpretQualitativeResult("")).toBeNull()
  })

  it("maps lab orders to investigations by LOINC, code or name", () => {
    expect(investigationCodeFor({ loinc_code: "58413-6" })).toBe("MRDT")
    expect(investigationCodeFor({ code: "fbc" })).toBe("FBC")
    expect(investigationCodeFor({ test_name: "Malaria Pf antigen (RDT)" })).toBe("MRDT")
    expect(investigationCodeFor({ test_name: "Xpert MTB/RIF Ultra" })).toBe("GENEXPERT")
    expect(investigationCodeFor({ test_name: "Lipid profile" })).toBeNull()
  })
})
