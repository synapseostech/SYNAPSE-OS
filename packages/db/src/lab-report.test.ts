import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildLabReportArtifact } from "./lab-report.ts"

describe("Lab report artifacts", () => {
  it("renders escaped structured results with a reproducible content hash", () => {
    const input = {
      id: "report-1",
      tenantId: "tenant-1",
      patientId: "patient-1",
      orderId: "order-1",
      clinicalResultId: "result-1",
      accession: "LAB-20260908-000001",
      testName: "CBC <panel>",
      loincCode: "58450-8",
      specimenType: "EDTA blood",
      reportedAt: "2026-09-08T12:00:00.000Z",
      resultValue: "6.8",
      unit: "10*9/L",
      referenceRange: "4.0-11.0 10*9/L",
      abnormalFlag: "N",
      verifiedBy: "scientist-1",
    }
    const first = buildLabReportArtifact(input)
    const second = buildLabReportArtifact(input)
    assert.equal(first.contentHash, second.contentHash)
    assert.equal(first.htmlSnapshot.includes("CBC &lt;panel&gt;"), true)
    assert.equal(first.htmlSnapshot.includes("LAB-20260908-000001"), true)
    assert.equal(first.templateVersion, "lab-report.v1")
    assert.equal(first.status, "FINAL")
  })

  it("v2 prints names, not identifiers, and marks critical and amended reports", () => {
    const report = buildLabReportArtifact({
      id: "report-2",
      tenantId: "tenant-1",
      patientId: "9b1f0b8e-0000-4000-8000-000000000000",
      orderId: "order-1",
      clinicalResultId: "result-1",
      accession: "LAB-20261121-000001",
      testName: "Blood glucose",
      loincCode: "2345-7",
      reportedAt: "2026-11-21T09:00:00.000Z",
      resultValue: "28",
      unit: "mmol/L",
      referenceRange: "3.9–6.1 mmol/L",
      abnormalFlag: "CRIT",
      isCritical: true,
      verifiedBy: "4d1e0000-0000-4000-8000-000000000000",
      version: 2,
      status: "AMENDED",
      amendmentReason: "Transcription <error>",
      facilityName: "Kampala Diagnostics",
      patientName: "Nakato Jane",
      patientMrn: "KLA-1",
      patientSex: "F",
      patientAge: "36 y",
      verifiedByName: "Sarah Okello",
    })
    assert.equal(report.templateVersion, "lab-report.v2")
    assert.match(report.htmlSnapshot, /Kampala Diagnostics/)
    assert.match(report.htmlSnapshot, /Nakato Jane/)
    assert.match(report.htmlSnapshot, /Sarah Okello/)
    assert.match(report.htmlSnapshot, /CRITICAL RESULT/)
    assert.match(report.htmlSnapshot, /Transcription &lt;error&gt;/)
    assert.doesNotMatch(report.htmlSnapshot, /9b1f0b8e-0000/)
    assert.doesNotMatch(report.htmlSnapshot, /<script/i)
  })
})
