import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ageInYears, formatAge, normaliseLabSex, rowsToReferenceRanges } from "./lab-ranges.ts"
import { interpretResult, LabWorkflow, type LabOrder } from "./lab-workflow.ts"

const TENANT = "11111111-1111-4111-8111-111111111111"

describe("reference ranges from the database", () => {
  const rows = [
    { tenant_id: null, loinc_code: "718-7", test_name: "Hb", unit: "g/dL", sex: null, low: 11, high: 16 },
    { tenant_id: null, loinc_code: "718-7", test_name: "Hb", unit: "g/dL", sex: "F", low: 12, high: 15, critical_low: 7, critical_high: 20 },
    { tenant_id: TENANT, loinc_code: "718-7", test_name: "Hb", unit: "g/dL", sex: "F", low: 11.5, high: 15.5, critical_low: 6.5 },
    { tenant_id: "22222222-2222-4222-8222-222222222222", loinc_code: "718-7", test_name: "Hb", unit: "g/dL", sex: null, low: 1, high: 2 },
  ]

  it("puts this lab's interval first, then sex-specific national, then general, and drops other tenants", () => {
    const ranges = rowsToReferenceRanges(rows, TENANT)
    assert.equal(ranges.length, 3)
    assert.equal(ranges[0]!.low, 11.5)
    assert.equal(ranges[1]!.low, 12)
    assert.equal(ranges[2]!.low, 11)
  })

  it("interpretResult uses the tenant interval for a woman and the general one for a man", () => {
    const ranges = rowsToReferenceRanges(rows, TENANT)
    assert.equal(interpretResult({ loincCode: "718-7", value: "11.8", sex: "F", ranges }).flag, "N")
    assert.equal(interpretResult({ loincCode: "718-7", value: "11.8", sex: "M", ranges }).flag, "N")
    assert.equal(interpretResult({ loincCode: "718-7", value: "10.5", sex: "M", ranges }).flag, "L")
    const crit = interpretResult({ loincCode: "718-7", value: "6.0", sex: "F", ranges })
    assert.equal(crit.flag, "CRIT")
    assert.equal(crit.isCritical, true)
  })

  it("reads qualitative results without a range", () => {
    assert.equal(interpretResult({ loincCode: "58413-6", value: "Positive (Pf)", ranges: [] }).isAbnormal, true)
    assert.equal(interpretResult({ loincCode: "58413-6", value: "Negative", ranges: [] }).flag, "N")
    assert.equal(interpretResult({ loincCode: "75622-1", value: "Non-reactive", ranges: [] }).flag, "N")
    assert.equal(interpretResult({ loincCode: "75622-1", value: "Reactive", ranges: [] }).isAbnormal, true)
  })

  it("normalises sex and computes age", () => {
    assert.equal(normaliseLabSex("female"), "F")
    assert.equal(normaliseLabSex("M"), "M")
    assert.equal(normaliseLabSex("other"), "I")
    assert.equal(normaliseLabSex(""), null)
    const at = new Date("2026-11-21T00:00:00Z")
    assert.equal(ageInYears("1990-11-22", at), 35)
    assert.equal(ageInYears("1990-11-21", at), 36)
    assert.equal(formatAge("2026-05-01", at), "6 m")
    assert.equal(ageInYears("2030-01-01", at), null)
  })
})

describe("LabWorkflow with database ranges", () => {
  const order = (): LabOrder => ({
    id: "o1", tenantId: TENANT, patientId: "p1", encounterId: "e1", loincCode: "2345-7", testName: "Glucose",
    urgency: "ROUTINE", status: "RECEIVED", orderedBy: "u1", orderedAt: "2026-11-21T08:00:00Z", isSynthetic: false, correlationId: "e1",
  })

  it("flags against the range it is given and reports the catalogue unit when no range matches", () => {
    const lab = new LabWorkflow([order()])
    const { result } = lab.enterResult({ resultId: "r1", orderId: "o1", value: "6.5", ranges: [{ loincCode: "2345-7", testName: "Glucose", unit: "mmol/L", low: 4, high: 7 }] })
    assert.equal(result.flag, "N")
    const lab2 = new LabWorkflow([order()])
    const r2 = lab2.enterResult({ resultId: "r2", orderId: "o1", value: "6.5", ranges: [], unit: "mmol/L" }).result
    assert.equal(r2.unit, "mmol/L")
    assert.equal(r2.referenceRange, "not established")
  })

  it("allows a released report to be amended more than once", () => {
    const lab = new LabWorkflow([order()])
    lab.enterResult({ resultId: "r1", orderId: "o1", value: "6.5" })
    lab.verify("o1", "scientist-1")
    lab.release("o1")
    lab.amend({ amendmentId: "a1", orderId: "o1", newValue: "6.6", reason: "typo", amendedBy: "scientist-1" })
    const second = lab.amend({ amendmentId: "a2", orderId: "o1", newValue: "6.7", reason: "typo again", amendedBy: "scientist-1" })
    assert.equal(second.result.version, 3)
    assert.equal(lab.getOrder("o1").status, "AMENDED")
  })
})
