import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildContinuitySummary } from "./patient-continuity.ts"

const now = new Date("2026-11-20T09:00:00Z")
const patient = { id: "p1", full_name: "Test Patient", mrn: "MRN-1", sex: "female", dob: "1990-05-01", chronic_conditions: ["Hypertension"], allergies: ["Sulfa"] }

const base = {
  patient,
  currentEncounterId: "e-today",
  encounters: [
    { id: "e-today", visit_date: "2026-11-20T08:00:00Z", chief_complaint: "Headache", metadata: {} },
    { id: "e-last", visit_date: "2026-11-12T10:00:00Z", chief_complaint: "Fever and joint pains", metadata: { writeup: { assessment: "Likely malaria", plan: "AL for 3 days, review in 1 week if not better" } } },
    { id: "e-old", visit_date: "2026-06-01T10:00:00Z", chief_complaint: "Fever", metadata: {} },
  ],
  diagnoses: [
    { encounter_id: "e-last", stem_code: "1F40.Z", title: "Malaria due to Plasmodium falciparum, unspecified", certainty: "confirmed" },
    { encounter_id: "e-old", stem_code: "1F40.Z", title: "Malaria due to Plasmodium falciparum, unspecified", certainty: "confirmed" },
  ],
  prescriptions: [
    { encounter_id: "e-last", medication_display: "Artemether/lumefantrine", dose: "4 tabs BD", status: "dispensed" },
    { encounter_id: "e-last", medication_display: "Paracetamol", dose: "1 g TDS", status: "cancelled" },
  ],
  vitals: [
    { encounter_id: "e-old", recorded_at: "2026-06-01T10:05:00Z", bp_systolic: 132, bp_diastolic: 84, weight_kg: 70, temperature_c: 38.5 },
    { encounter_id: "e-last", recorded_at: "2026-11-12T10:05:00Z", bp_systolic: 152, bp_diastolic: 96, weight_kg: 64, temperature_c: 38.9 },
  ],
  labResults: [
    { lab_order_id: "o1", encounter_id: "e-last", test_name: "Haemoglobin", loinc_code: "718-7", numeric_value: 9.1, unit: "g/dL", abnormal_flag: "L", is_abnormal: true, status: "released", verified_at: "2026-11-12T12:00:00Z" },
    { lab_order_id: "o0", encounter_id: "e-old", test_name: "Haemoglobin", loinc_code: "718-7", numeric_value: 12.4, unit: "g/dL", status: "released", verified_at: "2026-06-01T12:00:00Z" },
  ],
  labOrders: [
    { id: "o1", encounter_id: "e-last", test_name: "Haemoglobin", workflow_status: "released", ordered_at: "2026-11-12T10:10:00Z" },
    { id: "o2", encounter_id: "e-last", test_name: "Blood culture", workflow_status: "received", ordered_at: "2026-11-12T10:10:00Z" },
  ],
  allergies: [{ allergen: "Penicillin", reaction: "Rash", severity: "moderate" }],
  now,
}

describe("patient continuity summary", () => {
  const s = buildContinuitySummary(base)

  it("summarises the last visit, not today's", () => {
    assert.equal(s.visitCount, 2)
    assert.equal(s.lastVisit?.encounterId, "e-last")
    assert.equal(s.lastVisit?.daysAgo, 7)
    assert.equal(s.lastVisit?.complaint, "Fever and joint pains")
    assert.equal(s.lastVisit?.plan, "AL for 3 days, review in 1 week if not better")
    assert.deepEqual(s.lastVisit?.diagnoses.map((d) => d.code), ["1F40.Z"])
  })

  it("leaves out cancelled prescriptions", () => {
    assert.deepEqual(s.lastVisit?.medications, ["Artemether/lumefantrine 4 tabs BD"])
  })

  it("lists tests still waiting for a result and abnormal results", () => {
    assert.deepEqual(s.lastVisit?.pendingTests.map((t) => t.name), ["Blood culture"])
    assert.equal(s.lastVisit?.results.find((r) => r.name === "Haemoglobin")?.abnormal, true)
    assert.ok(s.workPlan.some((w) => w.includes("Blood culture")))
  })

  it("counts recurring problems and treats them as chronic", () => {
    assert.equal(s.recurringProblems[0]?.code, "1F40.Z")
    assert.equal(s.recurringProblems[0]?.count, 2)
    assert.ok(s.chronicConditions.includes("Hypertension"))
    assert.ok(s.chronicConditions.includes("Malaria due to Plasmodium falciparum, unspecified"))
  })

  it("builds vital and lab trends with direction and raises alerts", () => {
    const sys = s.vitalTrends.find((t) => t.key === "bp_systolic")
    assert.equal(sys?.direction, "rising")
    assert.equal(sys?.latest, 152)
    const hb = s.labTrends.find((t) => t.label === "Haemoglobin")
    assert.equal(hb?.direction, "falling")
    const texts = s.alerts.map((a) => a.text).join(" | ")
    assert.match(texts, /Systolic BP rising/)
    assert.match(texts, /Weight down 9%/)
    assert.match(texts, /Haemoglobin falling/)
    assert.match(texts, /Returned within 7 days/)
  })

  it("merges allergy rows with the allergies list on the patient", () => {
    assert.deepEqual(s.allergies.map((a) => a.allergen), ["Penicillin", "Sulfa"])
  })

  it("works out age and sex", () => {
    assert.equal(s.patient.sex, "F")
    assert.equal(Math.floor(s.patient.ageYears ?? 0), 36)
  })

  it("a first visit has no last visit and no alerts", () => {
    const first = buildContinuitySummary({ ...base, encounters: [base.encounters[0]!], diagnoses: [], prescriptions: [], vitals: [], labResults: [], labOrders: [] })
    assert.equal(first.visitCount, 0)
    assert.equal(first.lastVisit, null)
    assert.deepEqual(first.alerts, [])
  })
})
