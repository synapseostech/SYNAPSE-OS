/**
 * Radiology request -> exam -> report -> verification, on the existing
 * imaging_studies and radiology_reports tables.
 *
 * imaging_studies.worklist_status carries the workflow:
 *   pending (requested) -> in_progress (patient in the room) -> reported
 *   (radiographer's or radiologist's draft) -> verified (radiologist signed).
 * imaging_studies.status stays an image-storage state: 'processing' until
 * images are attached ('available').
 *
 * Pure: routes load and write rows.
 */

export type ImagingModality = "XR" | "US" | "CT" | "MRI" | "ECHO" | "MAMMOGRAPHY" | "FLUOROSCOPY" | "OTHER"
export type ImagingExam = { code: string; name: string; modality: ImagingModality; bodyPart: string; sided?: boolean }

/** Common exams in Ugandan hospitals. Codes are Synapse's; facilities price them in service_catalog by name. */
export const IMAGING_EXAMS: ImagingExam[] = [
  { code: "CXR", name: "Chest X-ray", modality: "XR", bodyPart: "chest" },
  { code: "AXR", name: "Abdominal X-ray", modality: "XR", bodyPart: "abdomen" },
  { code: "SKULL_XR", name: "Skull X-ray", modality: "XR", bodyPart: "skull" },
  { code: "SPINE_XR", name: "Spine X-ray", modality: "XR", bodyPart: "spine" },
  { code: "PELVIS_XR", name: "Pelvis X-ray", modality: "XR", bodyPart: "pelvis" },
  { code: "LIMB_XR", name: "Limb X-ray", modality: "XR", bodyPart: "limb", sided: true },
  { code: "ABD_US", name: "Abdominal ultrasound", modality: "US", bodyPart: "abdomen" },
  { code: "PELVIC_US", name: "Pelvic ultrasound", modality: "US", bodyPart: "pelvis" },
  { code: "OBS_US", name: "Obstetric ultrasound", modality: "US", bodyPart: "pelvis" },
  { code: "BREAST_US", name: "Breast ultrasound", modality: "US", bodyPart: "breast", sided: true },
  { code: "NECK_US", name: "Neck / thyroid ultrasound", modality: "US", bodyPart: "neck" },
  { code: "ECHO", name: "Echocardiogram", modality: "ECHO", bodyPart: "heart" },
  { code: "CT_HEAD", name: "CT head", modality: "CT", bodyPart: "head" },
  { code: "CT_CHEST", name: "CT chest", modality: "CT", bodyPart: "chest" },
  { code: "CT_ABD", name: "CT abdomen and pelvis", modality: "CT", bodyPart: "abdomen" },
  { code: "MRI_BRAIN", name: "MRI brain", modality: "MRI", bodyPart: "brain" },
  { code: "MRI_SPINE", name: "MRI spine", modality: "MRI", bodyPart: "spine" },
  { code: "MAMMO", name: "Mammogram", modality: "MAMMOGRAPHY", bodyPart: "breast", sided: true },
]

export function imagingExam(code: string | null | undefined): ImagingExam | null {
  const c = String(code ?? "").trim().toUpperCase()
  return IMAGING_EXAMS.find((e) => e.code === c) ?? null
}

export type WorklistStatus = "pending" | "in_progress" | "reported" | "verified"
export type RadiologyAction = "start" | "report" | "verify" | "cancel"

/** Which status an action needs and leads to. Re-reporting a draft is allowed. */
export const RADIOLOGY_TRANSITIONS: Record<RadiologyAction, { from: WorklistStatus[]; to: WorklistStatus | "cancelled" }> = {
  start: { from: ["pending"], to: "in_progress" },
  report: { from: ["in_progress", "reported"], to: "reported" },
  verify: { from: ["reported"], to: "verified" },
  cancel: { from: ["pending", "in_progress"], to: "cancelled" },
}

export function nextWorklistStatus(action: RadiologyAction, current: string): { ok: true; to: WorklistStatus | "cancelled" } | { ok: false; reason: string } {
  const t = RADIOLOGY_TRANSITIONS[action]
  if (!t) return { ok: false, reason: "Unknown action" }
  if (!t.from.includes(current as WorklistStatus)) {
    return { ok: false, reason: `Cannot ${action} an exam that is ${current.replace(/_/g, " ")}` }
  }
  return { ok: true, to: t.to }
}

export type RadiologyReportDraft = {
  technique?: string | null
  findings: string
  impression: string
  recommendation?: string | null
  isCritical?: boolean
}

const MAX = 8000

export function validateReportDraft(input: Partial<RadiologyReportDraft> | null | undefined): { ok: true; draft: RadiologyReportDraft } | { ok: false; reason: string } {
  const findings = String(input?.findings ?? "").trim()
  const impression = String(input?.impression ?? "").trim()
  if (findings.length < 3) return { ok: false, reason: "Write the findings" }
  if (impression.length < 3) return { ok: false, reason: "Write the impression" }
  const clip = (v: unknown) => {
    const s = String(v ?? "").trim()
    return s ? s.slice(0, MAX) : null
  }
  return {
    ok: true,
    draft: {
      technique: clip(input?.technique),
      findings: findings.slice(0, MAX),
      impression: impression.slice(0, MAX),
      recommendation: clip(input?.recommendation),
      isCritical: Boolean(input?.isCritical),
    },
  }
}

function esc(v: string | null | undefined): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function paragraphs(v: string | null | undefined): string {
  return esc(v).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("")
}

function when(v: string | null | undefined): string {
  if (!v) return "—"
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? esc(v) : esc(d.toISOString().replace("T", " ").slice(0, 16) + " UTC")
}

export type RadiologyReportPrint = {
  facilityName?: string | null
  accession: string | null
  examName: string
  modality: string
  bodyPart?: string | null
  laterality?: string | null
  patientName?: string | null
  patientMrn?: string | null
  patientSex?: string | null
  patientAge?: string | null
  clinicalIndication?: string | null
  requestedAt?: string | null
  technique?: string | null
  findings: string
  impression: string
  recommendation?: string | null
  isCritical?: boolean
  verified: boolean
  reportedByName?: string | null
  verifiedByName?: string | null
  reportedAt?: string | null
}

/** A4 printable report. A draft prints with a PRELIMINARY banner. */
export function renderRadiologyReportHtml(r: RadiologyReportPrint): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.examName)} ${esc(r.accession)}</title><style>
@page{size:A4;margin:16mm}
body{font-family:Arial,Helvetica,sans-serif;color:#17212b;margin:24px;font-size:13px;line-height:1.45}
header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #17212b;padding-bottom:8px;margin-bottom:16px}
h1{font-size:20px;margin:0}h2{font-size:14px;margin:16px 0 4px;text-transform:uppercase;letter-spacing:.03em;color:#56636f}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 24px}.meta div span{color:#56636f}
.banner{border:2px solid #b00020;color:#b00020;padding:6px 10px;font-weight:700;margin:8px 0}
.draft{border:1px solid #8a5a00;color:#8a5a00;padding:6px 10px;margin:8px 0;font-weight:700}
.impression{font-weight:700}
footer{margin-top:24px;border-top:1px solid #ccd3d9;padding-top:8px;color:#56636f;font-size:11px}
</style></head><body>
<header><div><h1>${esc(r.facilityName ?? "Radiology")}</h1><div>Radiology report</div></div><div style="text-align:right"><div><strong>${esc(r.accession ?? "—")}</strong></div><div>${esc(r.examName)} · ${esc(r.modality)}</div></div></header>
${r.verified ? "" : '<div class="draft">PRELIMINARY: not yet verified by a radiologist.</div>'}
${r.isCritical ? '<div class="banner">CRITICAL FINDING: the requesting clinician must be informed.</div>' : ""}
<section class="meta">
<div><span>Patient:</span> <strong>${esc(r.patientName ?? "—")}</strong></div>
<div><span>Patient no.:</span> ${esc(r.patientMrn ?? "—")}</div>
<div><span>Sex / age:</span> ${esc(r.patientSex ?? "—")} / ${esc(r.patientAge ?? "—")}</div>
<div><span>Requested:</span> ${when(r.requestedAt)}</div>
<div><span>Body part:</span> ${esc([r.bodyPart, r.laterality].filter(Boolean).join(", ") || "—")}</div>
<div><span>Reported:</span> ${when(r.reportedAt)}</div>
</section>
<h2>Clinical indication</h2>${paragraphs(r.clinicalIndication || "—")}
${r.technique ? `<h2>Technique</h2>${paragraphs(r.technique)}` : ""}
<h2>Findings</h2>${paragraphs(r.findings)}
<h2>Impression</h2><div class="impression">${paragraphs(r.impression)}</div>
${r.recommendation ? `<h2>Recommendation</h2>${paragraphs(r.recommendation)}` : ""}
<section class="meta" style="margin-top:16px">
<div><span>Reported by:</span> ${esc(r.reportedByName ?? "—")}</div>
<div><span>Verified by:</span> <strong>${esc(r.verifiedByName ?? (r.verified ? "—" : "Not yet verified"))}</strong></div>
</section>
<footer>Interpret with the clinical picture. Images are held by the imaging department.</footer>
</body></html>`
}
