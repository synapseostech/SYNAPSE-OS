import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HMIS105_OPD_CATEGORIES, ageBandAt, buildHmis105Report, hmis105CategoryFor, hmis105Csv } from "./hmis105.ts"
import { buildAggregateDataValueSet } from "./privacy-export.ts"
import { DEFAULT_PRIVACY_EXPORT_POLICY } from "./types.ts"
import { ICD11_MMS_TSV } from "../terminology/icd11-mms-data.ts"
import { icd11Ancestors, isIcd11Code } from "../terminology/icd11-index.ts"

const ALL_CODES = ICD11_MMS_TSV.split("\n").map((l) => l.split("\t")[0]!)

describe("HMIS 105 OPD categories", () => {
  it("every root is a WHO code or a prefix of at least one", () => {
    for (const cat of HMIS105_OPD_CATEGORIES) {
      for (const root of cat.roots) {
        assert.ok(isIcd11Code(root) || ALL_CODES.some((c) => c.startsWith(root)), `${cat.key}: ${root}`)
      }
    }
  })

  it("keys are unique", () => {
    assert.equal(new Set(HMIS105_OPD_CATEGORIES.map((c) => c.key)).size, HMIS105_OPD_CATEGORIES.length)
  })

  it("puts codes in the right category, specific before general", () => {
    assert.equal(hmis105CategoryFor("1F40.Z")?.key, "malaria_confirmed")
    assert.equal(hmis105CategoryFor("1F45")?.key, "malaria_presumed")
    assert.equal(hmis105CategoryFor("1A00")?.key, "cholera")
    assert.equal(hmis105CategoryFor("1A02")?.key, "dysentery")
    assert.equal(hmis105CategoryFor("1A07.Z")?.key, "typhoid")
    assert.equal(hmis105CategoryFor("1A40.Z")?.key, "diarrhoea_acute")
    assert.equal(hmis105CategoryFor("3A51.2")?.key, "sickle_cell")
    assert.equal(hmis105CategoryFor("3A00.Z")?.key, "anaemia")
    assert.equal(hmis105CategoryFor("5A22.0")?.key, "diabetes")
    assert.equal(hmis105CategoryFor("NA00")?.key, "injuries")
    assert.equal(hmis105CategoryFor("6A70")?.key, "mental")
    assert.equal(hmis105CategoryFor("CA40.Z")?.key, "pneumonia")
    assert.equal(hmis105CategoryFor("CA07.0")?.key, "cough_cold")
    assert.equal(hmis105CategoryFor("XY99"), null)
  })
})

describe("age bands", () => {
  it("uses the HMIS 105 columns", () => {
    assert.equal(ageBandAt("2026-11-01", "2026-11-20"), "0_28d")
    assert.equal(ageBandAt("2026-09-01", "2026-11-20"), "29d_4y")
    assert.equal(ageBandAt("2015-01-01", "2026-11-20"), "5_59y")
    assert.equal(ageBandAt("1950-01-01", "2026-11-20"), "60y")
    assert.equal(ageBandAt(null, "2026-11-20"), "unknown")
    assert.equal(ageBandAt("2027-01-01", "2026-11-20"), "unknown")
  })
})

describe("monthly report", () => {
  const rows = [
    { encounter_id: "e1", stem_code: "1F40.Z", certainty: "confirmed", visit_date: "2026-11-03", dob: "2023-01-01", sex: "F" },
    { encounter_id: "e1", stem_code: "1F40", certainty: "confirmed", visit_date: "2026-11-03", dob: "2023-01-01", sex: "F" }, // same visit, same category
    { encounter_id: "e2", stem_code: "1F40.Z", certainty: "suspected", visit_date: "2026-11-04", dob: "1990-01-01", sex: "male" },
    { encounter_id: "e3", stem_code: "CA40.Z", certainty: "differential", visit_date: "2026-11-05", dob: "1990-01-01", sex: "M" },
    { encounter_id: "e4", stem_code: "BA00.Z", certainty: "confirmed", visit_date: "2026-11-06", dob: null, sex: "F" },
    { encounter_id: "e5", stem_code: "XB00", certainty: "confirmed", visit_date: "2026-11-06", dob: "1990-01-01", sex: "F" },
  ]
  const r = buildHmis105Report("202611", rows)
  const row = (k: string) => r.rows.find((x) => x.key === k)!

  it("counts one case per visit per category, by age band and sex", () => {
    assert.equal(row("malaria_confirmed").total, 2)
    assert.equal(row("malaria_confirmed").bands["29d_4y"].F, 1)
    assert.equal(row("malaria_confirmed").bands["5_59y"].M, 1)
  })

  it("leaves out rule-out (differential) diagnoses", () => {
    assert.equal(row("pneumonia").total, 0)
    assert.equal(r.totals.excludedDifferential, 1)
  })

  it("keeps cases with unknown age, and flags them", () => {
    assert.equal(row("hypertension").bands.unknown.F, 1)
    assert.equal(r.totals.unknownAgeOrSex, 1)
  })

  it("lists diagnoses outside the HMIS categories", () => {
    assert.deepEqual(r.otherDiagnoses, [{ code: "XB00", count: 1 }])
    assert.equal(r.totals.cases, 3)
  })

  it("exports CSV in HMIS column order", () => {
    const csv = hmis105Csv(r).split("\n")
    assert.match(csv[0]!, /^Group,Diagnosis,0–28 days M,0–28 days F,29 days–4 years M/)
    const malaria = csv.find((l) => l.includes("Malaria (confirmed)"))!
    assert.equal(malaria, "Communicable,Malaria (confirmed),0,0,0,1,1,0,0,0,0,2")
  })
})

describe("DHIS2 export rolls specific codes up to the mapped parent", () => {
  it("walks WHO ancestors", () => {
    assert.deepEqual(icd11Ancestors("1F40.Z").slice(0, 2), ["1F40.Z", "1F40"])
  })

  const mappings = [{ icd11StemCode: "1F40", dhis2DataElementId: "DE_MALARIA" }]
  const run = (facts: { icd11StemCode: string; count: number }[], minCellCount = 3) =>
    buildAggregateDataValueSet({
      source: facts.map((f) => ({ localOrgKey: "f1", period: "202611", ...f })),
      period: "202611",
      orgUnit: "OU",
      orgUnitMappings: [],
      dataElementMappings: mappings as never,
      policy: { ...DEFAULT_PRIVACY_EXPORT_POLICY, minCellCount },
      capabilityGranted: true,
      mode: "simulation",
    })

  it("1F40.Z and 1F40.0 count under the 1F40 element", () => {
    const res = run([{ icd11StemCode: "1F40.Z", count: 2 }, { icd11StemCode: "1F40.0", count: 1 }, { icd11StemCode: "1F40", count: 1 }])
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.dataValueSet.dataValues, [{ dataElement: "DE_MALARIA", orgUnit: "OU", period: "202611", value: "4" }])
  })

  it("suppresses on the summed cell, not on each code", () => {
    const res = run([{ icd11StemCode: "1F40.Z", count: 2 }, { icd11StemCode: "1F40", count: 2 }], 3)
    assert.equal(res.ok, true)
    const small = run([{ icd11StemCode: "1F40.Z", count: 1 }, { icd11StemCode: "1F40", count: 1 }], 3)
    assert.equal(small.ok, false)
  })
})
