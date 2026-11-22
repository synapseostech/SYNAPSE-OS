import { createHash } from "node:crypto"

export type LabReportStatus = "FINAL" | "AMENDED"

export type LabReportInput = {
  id: string
  tenantId: string
  facilityId?: string | null
  patientId: string
  encounterId?: string | null
  orderId: string
  clinicalResultId: string
  accession: string
  testName: string
  loincCode: string
  specimenType?: string | null
  collectedAt?: string | null
  receivedAt?: string | null
  reportedAt: string
  resultValue: string
  unit?: string | null
  referenceRange?: string | null
  abnormalFlag?: string | null
  isCritical?: boolean
  verifiedBy?: string | null
  version?: number
  status?: LabReportStatus
  supersedesReportId?: string | null
  amendmentReason?: string | null
  /** v2 fields: names, not identifiers, on the printed report. */
  facilityName?: string | null
  patientName?: string | null
  patientMrn?: string | null
  patientSex?: string | null
  patientAge?: string | null
  section?: string | null
  enteredByName?: string | null
  verifiedByName?: string | null
  referralSource?: string | null
}

export type LabReportArtifact = LabReportInput & {
  htmlSnapshot: string
  contentHash: string
  templateVersion: "lab-report.v1" | "lab-report.v2"
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function isV2(input: LabReportInput): boolean {
  return Boolean(input.facilityName || input.patientName || input.verifiedByName)
}

const FLAG_LABEL: Record<string, string> = {
  N: "Normal", H: "High", L: "Low", HH: "Very high", LL: "Very low", A: "Abnormal", AA: "Very abnormal", CRIT: "CRITICAL",
}

function renderLabReportHtmlV1(input: LabReportInput): string {
  const critical = input.isCritical ? " CRITICAL" : ""
  return `<!doctype html><html><head><meta charset="utf-8"><title>Laboratory Report ${escapeHtml(input.accession)}</title><style>body{font-family:Arial,sans-serif;color:#17212b;margin:32px}header{border-bottom:2px solid #17212b;margin-bottom:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd3d9;padding:8px;text-align:left}.flag{font-weight:700}</style></head><body><header><h1>Laboratory Report</h1><p>Accession: ${escapeHtml(input.accession)} · Version ${input.version ?? 1}</p></header><section><h2>Patient and specimen</h2><p>Patient ID: ${escapeHtml(input.patientId)}</p><p>Specimen: ${escapeHtml(input.specimenType)}</p><p>Collected: ${escapeHtml(input.collectedAt)} · Received: ${escapeHtml(input.receivedAt)}</p></section><table><thead><tr><th>Test</th><th>LOINC</th><th>Result</th><th>Unit</th><th>Reference interval</th><th>Flag</th></tr></thead><tbody><tr><td>${escapeHtml(input.testName)}</td><td>${escapeHtml(input.loincCode)}</td><td>${escapeHtml(input.resultValue)}</td><td>${escapeHtml(input.unit)}</td><td>${escapeHtml(input.referenceRange)}</td><td class="flag">${escapeHtml(input.abnormalFlag)}${critical}</td></tr></tbody></table><p>Reported: ${escapeHtml(input.reportedAt)}</p><p>Verified by: ${escapeHtml(input.verifiedBy)}</p></body></html>`
}

function when(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return escapeHtml(value)
  return escapeHtml(d.toISOString().replace("T", " ").slice(0, 16) + " UTC")
}

function renderLabReportHtmlV2(input: LabReportInput): string {
  const flag = input.isCritical ? "CRIT" : String(input.abnormalFlag ?? "N")
  const flagText = FLAG_LABEL[flag] ?? flag
  const abnormal = flag !== "N"
  const amended = input.status === "AMENDED"
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laboratory report ${escapeHtml(input.accession)}</title><style>
@page{size:A4;margin:16mm}
body{font-family:Arial,Helvetica,sans-serif;color:#17212b;margin:24px;font-size:13px;line-height:1.4}
header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #17212b;padding-bottom:8px;margin-bottom:16px}
h1{font-size:20px;margin:0}h2{font-size:14px;margin:16px 0 6px}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 24px}
.meta div span{color:#56636f}
table{border-collapse:collapse;width:100%;margin-top:8px}td,th{border:1px solid #ccd3d9;padding:8px;text-align:left;vertical-align:top}th{background:#f1f4f6}
.abn{font-weight:700}.crit{font-weight:700;color:#b00020}
.banner{border:2px solid #b00020;color:#b00020;padding:6px 10px;font-weight:700;margin:8px 0}
.amend{border:1px solid #8a5a00;color:#8a5a00;padding:6px 10px;margin:8px 0}
footer{margin-top:24px;border-top:1px solid #ccd3d9;padding-top:8px;color:#56636f;font-size:11px}
</style></head><body>
<header><div><h1>${escapeHtml(input.facilityName ?? "Laboratory")}</h1><div>Laboratory report</div></div><div style="text-align:right"><div><strong>${escapeHtml(input.accession)}</strong></div><div>Version ${input.version ?? 1}${amended ? " · AMENDED" : ""}</div></div></header>
${input.isCritical ? '<div class="banner">CRITICAL RESULT: the requesting clinician must be informed.</div>' : ""}
${amended ? `<div class="amend">Amended report. Reason: ${escapeHtml(input.amendmentReason)}. This version replaces earlier versions.</div>` : ""}
<section class="meta">
<div><span>Patient:</span> <strong>${escapeHtml(input.patientName ?? "—")}</strong></div>
<div><span>Patient no.:</span> ${escapeHtml(input.patientMrn ?? "—")}</div>
<div><span>Sex / age:</span> ${escapeHtml(input.patientSex ?? "—")} / ${escapeHtml(input.patientAge ?? "—")}</div>
<div><span>Requested by:</span> ${escapeHtml(input.referralSource ?? "—")}</div>
<div><span>Specimen:</span> ${escapeHtml(input.specimenType ?? "—")}</div>
<div><span>Section:</span> ${escapeHtml(input.section ?? "—")}</div>
<div><span>Collected:</span> ${when(input.collectedAt)}</div>
<div><span>Received:</span> ${when(input.receivedAt)}</div>
</section>
<table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference interval</th><th>Flag</th></tr></thead>
<tbody><tr><td>${escapeHtml(input.testName)}<br><small>LOINC ${escapeHtml(input.loincCode)}</small></td><td class="${input.isCritical ? "crit" : abnormal ? "abn" : ""}">${escapeHtml(input.resultValue)}</td><td>${escapeHtml(input.unit)}</td><td>${escapeHtml(input.referenceRange)}</td><td class="${input.isCritical ? "crit" : abnormal ? "abn" : ""}">${escapeHtml(flagText)}</td></tr></tbody></table>
<section class="meta" style="margin-top:16px">
<div><span>Entered by:</span> ${escapeHtml(input.enteredByName ?? "—")}</div>
<div><span>Authorised by:</span> <strong>${escapeHtml(input.verifiedByName ?? input.verifiedBy ?? "—")}</strong></div>
<div><span>Reported:</span> ${when(input.reportedAt)}</div>
</section>
<footer>Results relate only to the specimen received. Interpret with the clinical picture. Report ${escapeHtml(input.id)}.</footer>
</body></html>`
}

export function renderLabReportHtml(input: LabReportInput): string {
  return isV2(input) ? renderLabReportHtmlV2(input) : renderLabReportHtmlV1(input)
}

export function buildLabReportArtifact(input: LabReportInput): LabReportArtifact {
  const htmlSnapshot = renderLabReportHtml(input)
  return {
    ...input,
    version: input.version ?? 1,
    status: input.status ?? "FINAL",
    templateVersion: isV2(input) ? "lab-report.v2" : "lab-report.v1",
    htmlSnapshot,
    contentHash: createHash("sha256").update(htmlSnapshot).digest("hex"),
  }
}
// ---------------------------------------------------------------------------
// Panel report (FBC, LFT, RFT…): one printable page for all of a panel's
// analytes. A summary generated on request from the authorised component
// results; each component's own report stays the immutable record.
// ---------------------------------------------------------------------------

export type PanelReportRow = {
  testName: string
  loincCode: string | null
  /** Only authorised (released or amended) results are printed. */
  released: boolean
  resultValue?: string | null
  unit?: string | null
  referenceRange?: string | null
  abnormalFlag?: string | null
  isCritical?: boolean
  amended?: boolean
}

export type PanelReportInput = {
  panelOrderId: string
  panelCode: string
  panelName: string
  accession: string
  facilityName?: string | null
  patientName?: string | null
  patientMrn?: string | null
  patientSex?: string | null
  patientAge?: string | null
  referralSource?: string | null
  specimenType?: string | null
  collectedAt?: string | null
  receivedAt?: string | null
  authorisedBy: string[]
  generatedAt: string
  rows: PanelReportRow[]
}

export function renderPanelReportHtml(input: PanelReportInput): string {
  const pending = input.rows.filter((r) => !r.released).length
  const critical = input.rows.some((r) => r.released && r.isCritical)
  const amended = input.rows.some((r) => r.released && r.amended)
  const rows = input.rows
    .map((r) => {
      if (!r.released) {
        return `<tr class="pending"><td>${escapeHtml(r.testName)}${r.loincCode ? `<br><small>LOINC ${escapeHtml(r.loincCode)}</small>` : ""}</td><td colspan="4">Pending authorisation</td></tr>`
      }
      const flag = r.isCritical ? "CRIT" : String(r.abnormalFlag ?? "N")
      const cls = r.isCritical ? "crit" : flag !== "N" ? "abn" : ""
      return `<tr><td>${escapeHtml(r.testName)}${r.loincCode ? `<br><small>LOINC ${escapeHtml(r.loincCode)}</small>` : ""}${r.amended ? ' <small class="am">amended</small>' : ""}</td><td class="${cls}">${escapeHtml(r.resultValue)}</td><td>${escapeHtml(r.unit)}</td><td>${escapeHtml(r.referenceRange)}</td><td class="${cls}">${escapeHtml(FLAG_LABEL[flag] ?? flag)}</td></tr>`
    })
    .join("")
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.panelName)} ${escapeHtml(input.accession)}</title><style>
@page{size:A4;margin:16mm}
body{font-family:Arial,Helvetica,sans-serif;color:#17212b;margin:24px;font-size:13px;line-height:1.4}
header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #17212b;padding-bottom:8px;margin-bottom:16px}
h1{font-size:20px;margin:0}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 24px}
.meta div span{color:#56636f}
table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border:1px solid #ccd3d9;padding:7px;text-align:left;vertical-align:top}th{background:#f1f4f6}
.abn{font-weight:700}.crit{font-weight:700;color:#b00020}.pending td{color:#56636f;font-style:italic}.am{color:#8a5a00}
.banner{border:2px solid #b00020;color:#b00020;padding:6px 10px;font-weight:700;margin:8px 0}
.note{border:1px solid #8a5a00;color:#8a5a00;padding:6px 10px;margin:8px 0}
footer{margin-top:24px;border-top:1px solid #ccd3d9;padding-top:8px;color:#56636f;font-size:11px}
</style></head><body>
<header><div><h1>${escapeHtml(input.facilityName ?? "Laboratory")}</h1><div>${escapeHtml(input.panelName)} (${escapeHtml(input.panelCode)})</div></div><div style="text-align:right"><div><strong>${escapeHtml(input.accession)}</strong></div><div>${pending ? `${pending} result${pending > 1 ? "s" : ""} pending` : "Complete"}</div></div></header>
${critical ? '<div class="banner">CRITICAL RESULT: the requesting clinician must be informed.</div>' : ""}
${pending ? '<div class="note">Interim report: results still pending authorisation are not shown.</div>' : ""}
${amended ? '<div class="note">One or more results were amended after first release.</div>' : ""}
<section class="meta">
<div><span>Patient:</span> <strong>${escapeHtml(input.patientName ?? "—")}</strong></div>
<div><span>Patient no.:</span> ${escapeHtml(input.patientMrn ?? "—")}</div>
<div><span>Sex / age:</span> ${escapeHtml(input.patientSex ?? "—")} / ${escapeHtml(input.patientAge ?? "—")}</div>
<div><span>Requested by:</span> ${escapeHtml(input.referralSource ?? "—")}</div>
<div><span>Specimen:</span> ${escapeHtml(input.specimenType ?? "—")}</div>
<div><span>Collected:</span> ${when(input.collectedAt)}</div>
<div><span>Received:</span> ${when(input.receivedAt)}</div>
<div><span>Authorised by:</span> <strong>${escapeHtml(input.authorisedBy.length ? input.authorisedBy.join(", ") : "—")}</strong></div>
</section>
<table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference interval</th><th>Flag</th></tr></thead><tbody>${rows}</tbody></table>
<footer>Results relate only to the specimen received. Interpret with the clinical picture. Printed ${when(input.generatedAt)} from the authorised results of order ${escapeHtml(input.panelOrderId)}; each test's own report is the record of release.</footer>
</body></html>`
}
