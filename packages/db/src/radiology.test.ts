import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { IMAGING_EXAMS, imagingExam, nextWorklistStatus, renderRadiologyReportHtml, validateReportDraft } from "./radiology.ts"

const MODALITIES = new Set(["XR", "CT", "MRI", "US", "ECHO", "NM", "PET", "MAMMOGRAPHY", "FLUOROSCOPY", "ANGIO", "OTHER"])

describe("imaging exams", () => {
  it("every exam uses a modality the imaging_studies table accepts, with unique codes", () => {
    for (const e of IMAGING_EXAMS) assert.ok(MODALITIES.has(e.modality), e.code)
    assert.equal(new Set(IMAGING_EXAMS.map((e) => e.code)).size, IMAGING_EXAMS.length)
  })
  it("looks up by code, case-insensitive", () => {
    assert.equal(imagingExam("cxr")?.name, "Chest X-ray")
    assert.equal(imagingExam("nope"), null)
  })
})

describe("radiology workflow", () => {
  it("follows request -> exam -> report -> verify", () => {
    assert.deepEqual(nextWorklistStatus("start", "pending"), { ok: true, to: "in_progress" })
    assert.deepEqual(nextWorklistStatus("report", "in_progress"), { ok: true, to: "reported" })
    assert.deepEqual(nextWorklistStatus("report", "reported"), { ok: true, to: "reported" })
    assert.deepEqual(nextWorklistStatus("verify", "reported"), { ok: true, to: "verified" })
  })
  it("refuses steps out of order", () => {
    assert.equal(nextWorklistStatus("verify", "pending").ok, false)
    assert.equal(nextWorklistStatus("report", "verified").ok, false)
    assert.equal(nextWorklistStatus("cancel", "verified").ok, false)
    assert.equal(nextWorklistStatus("start", "in_progress").ok, false)
  })
})

describe("report drafts", () => {
  it("needs findings and impression", () => {
    assert.equal(validateReportDraft({ findings: "", impression: "Normal" }).ok, false)
    assert.equal(validateReportDraft({ findings: "Clear lung fields", impression: "" }).ok, false)
    const ok = validateReportDraft({ findings: " Clear lung fields ", impression: "Normal chest", technique: "  ", isCritical: true })
    assert.ok(ok.ok)
    if (ok.ok) {
      assert.equal(ok.draft.findings, "Clear lung fields")
      assert.equal(ok.draft.technique, null)
      assert.equal(ok.draft.isCritical, true)
    }
  })
})

describe("printed report", () => {
  const base = { accession: "RAD-20261122-000001", examName: "Chest X-ray", modality: "XR", findings: "Right lower lobe <opacity>.", impression: "Pneumonia" }
  it("escapes text and marks drafts as preliminary", () => {
    const html = renderRadiologyReportHtml({ ...base, verified: false })
    assert.match(html, /PRELIMINARY/)
    assert.match(html, /&lt;opacity&gt;/)
    assert.doesNotMatch(html, /<opacity>/)
  })
  it("verified, critical report names the radiologist", () => {
    const html = renderRadiologyReportHtml({ ...base, verified: true, isCritical: true, verifiedByName: "Dr Demo Radiologist" })
    assert.doesNotMatch(html, /PRELIMINARY/)
    assert.match(html, /CRITICAL FINDING/)
    assert.match(html, /Dr Demo Radiologist/)
  })
})
