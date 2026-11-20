/**
 * Returning-patient summary for the consultation screen: what happened at the
 * last visit, what is still open, and how the numbers are trending, so the
 * clinician can set today's work plan in seconds.
 *
 * Pure: the route loads rows (tenant-scoped) and passes them in.
 */
import { writeupFromEncounterMetadata } from "./clinical-writeup"

export type ContinuityEncounterRow = {
  id: string
  visit_date: string | null
  created_at?: string | null
  chief_complaint: string | null
  metadata: unknown
  disposition?: string | null
  disposition_reason?: string | null
  status?: string | null
  is_signed?: boolean | null
}
export type ContinuityDiagnosisRow = { encounter_id: string; stem_code: string; title: string; certainty?: string | null; diagnosis_type?: string | null }
export type ContinuityPrescriptionRow = { encounter_id: string | null; medication_display: string | null; dose?: string | null; quantity?: number | string | null; unit?: string | null; status?: string | null; created_at?: string | null }
export type ContinuityVitalsRow = {
  encounter_id: string | null
  recorded_at: string | null
  bp_systolic?: number | string | null
  bp_diastolic?: number | string | null
  heart_rate?: number | string | null
  temperature_c?: number | string | null
  spo2?: number | string | null
  respiratory_rate?: number | string | null
  weight_kg?: number | string | null
}
export type ContinuityLabResultRow = {
  lab_order_id?: string | null
  encounter_id?: string | null
  test_name: string | null
  loinc_code?: string | null
  value?: string | null
  result_value?: string | null
  numeric_value?: number | string | null
  unit?: string | null
  flag?: string | null
  abnormal_flag?: string | null
  is_abnormal?: boolean | null
  is_critical?: boolean | null
  status?: string | null
  verified_at?: string | null
  created_at?: string | null
}
export type ContinuityLabOrderRow = { id: string; encounter_id: string | null; test_name: string | null; workflow_status?: string | null; status?: string | null; ordered_at: string | null }
export type ContinuityAllergyRow = { allergen: string; reaction?: string | null; severity?: string | null }
export type ContinuityPatientRow = {
  id: string
  full_name?: string | null
  mrn?: string | null
  sex?: string | null
  dob?: string | null
  date_of_birth?: string | null
  is_pregnant?: boolean | null
  chronic_conditions?: unknown
  current_medications?: unknown
  allergies?: unknown
  blood_group?: string | null
  district?: string | null
}

export type TrendPoint = { at: string; value: number; flag?: string | null }
export type TrendSeries = { key: string; label: string; unit: string; points: TrendPoint[]; direction: "rising" | "falling" | "steady" | "single"; latest: number | null; normal?: [number, number] }

export type ContinuitySummary = {
  patient: { id: string; name: string | null; mrn: string | null; sex: "M" | "F" | null; ageYears: number | null; pregnant: boolean; bloodGroup: string | null; district: string | null }
  visitCount: number
  firstSeen: string | null
  lastVisit: null | {
    encounterId: string
    date: string
    daysAgo: number
    complaint: string | null
    diagnoses: { code: string; title: string; certainty: string | null }[]
    medications: string[]
    assessment: string | null
    plan: string | null
    disposition: string | null
    pendingTests: { name: string; status: string; orderedAt: string | null }[]
    results: { name: string; value: string; unit: string | null; abnormal: boolean; critical: boolean }[]
    vitals: { bp: string | null; temp: number | null; weight: number | null; hr: number | null; spo2: number | null } | null
  }
  visits: { encounterId: string; date: string; complaint: string | null; diagnoses: string[] }[]
  recurringProblems: { code: string; title: string; count: number; lastSeen: string }[]
  chronicConditions: string[]
  allergies: { allergen: string; reaction: string | null; severity: string | null }[]
  vitalTrends: TrendSeries[]
  labTrends: TrendSeries[]
  alerts: { level: "info" | "warning" | "danger"; text: string }[]
  workPlan: string[]
}

const DAY = 86_400_000

function n(x: unknown): number | null {
  const v = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN
  return Number.isFinite(v) ? v : null
}

function ageYears(dob: string | null | undefined, now: Date): number | null {
  if (!dob) return null
  const d = new Date(dob)
  if (Number.isNaN(d.getTime())) return null
  const years = (now.getTime() - d.getTime()) / (365.25 * DAY)
  return years < 0 ? null : Math.round(years * 10) / 10
}

function sexOf(s: string | null | undefined): "M" | "F" | null {
  const v = String(s ?? "").trim().toLowerCase()
  if (v === "m" || v === "male") return "M"
  if (v === "f" || v === "female") return "F"
  return null
}

function listOf(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : v && typeof v === "object" ? String((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).condition ?? (v as Record<string, unknown>).allergen ?? "") : ""))
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof value === "string") return value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function when(e: { visit_date?: string | null; created_at?: string | null }): string {
  return e.visit_date ?? e.created_at ?? new Date(0).toISOString()
}

function direction(points: TrendPoint[]): TrendSeries["direction"] {
  if (points.length < 2) return "single"
  const first = points[0]!.value
  const last = points[points.length - 1]!.value
  const span = Math.max(Math.abs(first), 1)
  const change = (last - first) / span
  if (change > 0.08) return "rising"
  if (change < -0.08) return "falling"
  return "steady"
}

function series(key: string, label: string, unit: string, points: TrendPoint[], normal?: [number, number]): TrendSeries {
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at)).slice(-12)
  return { key, label, unit, points: sorted, direction: direction(sorted), latest: sorted.length ? sorted[sorted.length - 1]!.value : null, normal }
}

const PENDING_LAB = new Set(["ordered", "collected", "received", "in_progress", "resulted", "verified", "pending", "accepted"])

export function buildContinuitySummary(input: {
  patient: ContinuityPatientRow
  currentEncounterId?: string | null
  encounters: ContinuityEncounterRow[]
  diagnoses: ContinuityDiagnosisRow[]
  prescriptions: ContinuityPrescriptionRow[]
  vitals: ContinuityVitalsRow[]
  labResults: ContinuityLabResultRow[]
  labOrders: ContinuityLabOrderRow[]
  allergies: ContinuityAllergyRow[]
  now?: Date
}): ContinuitySummary {
  const now = input.now ?? new Date()
  const p = input.patient
  const age = ageYears(p.dob ?? p.date_of_birth, now)
  const sex = sexOf(p.sex)

  const past = input.encounters
    .filter((e) => e.id !== input.currentEncounterId)
    .sort((a, b) => when(b).localeCompare(when(a)))

  const dxByEncounter = new Map<string, ContinuityDiagnosisRow[]>()
  for (const d of input.diagnoses) {
    const list = dxByEncounter.get(d.encounter_id) ?? []
    list.push(d)
    dxByEncounter.set(d.encounter_id, list)
  }

  // Recurring problems across past visits.
  const problemMap = new Map<string, { code: string; title: string; count: number; lastSeen: string }>()
  for (const e of past) {
    const seen = new Set<string>()
    for (const d of dxByEncounter.get(e.id) ?? []) {
      if (seen.has(d.stem_code)) continue
      seen.add(d.stem_code)
      const prev = problemMap.get(d.stem_code)
      if (prev) {
        prev.count += 1
        if (when(e) > prev.lastSeen) prev.lastSeen = when(e)
      } else problemMap.set(d.stem_code, { code: d.stem_code, title: d.title, count: 1, lastSeen: when(e) })
    }
  }
  const recurringProblems = [...problemMap.values()].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)).slice(0, 8)

  const last = past[0]
  let lastVisit: ContinuitySummary["lastVisit"] = null
  const alerts: ContinuitySummary["alerts"] = []
  const workPlan: string[] = []

  if (last) {
    const w = writeupFromEncounterMetadata(last.metadata)
    const meds = input.prescriptions
      .filter((r) => r.encounter_id === last.id && r.medication_display && String(r.status ?? "").toLowerCase() !== "cancelled")
      .map((r) => [r.medication_display, r.dose].filter(Boolean).join(" "))
    const orders = input.labOrders.filter((o) => o.encounter_id === last.id)
    const resultsForLast = input.labResults.filter((r) => r.encounter_id === last.id || (r.lab_order_id && orders.some((o) => o.id === r.lab_order_id)))
    const releasedOrderIds = new Set(
      resultsForLast.filter((r) => ["released", "verified", "final"].includes(String(r.status ?? "").toLowerCase()) || r.verified_at).map((r) => r.lab_order_id),
    )
    const pendingTests = orders
      .filter((o) => {
        const s = String(o.workflow_status ?? o.status ?? "").toLowerCase()
        return !releasedOrderIds.has(o.id) && PENDING_LAB.has(s) && s !== "released"
      })
      .map((o) => ({ name: o.test_name ?? "Test", status: String(o.workflow_status ?? o.status ?? "ordered"), orderedAt: o.ordered_at }))
    const results = resultsForLast.map((r) => ({
      name: r.test_name ?? "Result",
      value: String(r.result_value ?? r.value ?? r.numeric_value ?? ""),
      unit: r.unit ?? null,
      abnormal: Boolean(r.is_abnormal || ["H", "L", "HH", "LL", "A", "ABNORMAL", "HIGH", "LOW"].includes(String(r.abnormal_flag ?? r.flag ?? "").toUpperCase())),
      critical: Boolean(r.is_critical),
    }))
    const v = input.vitals.filter((x) => x.encounter_id === last.id).sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)))[0]
    const daysAgo = Math.max(0, Math.floor((now.getTime() - new Date(when(last)).getTime()) / DAY))
    lastVisit = {
      encounterId: last.id,
      date: when(last),
      daysAgo,
      complaint: last.chief_complaint,
      diagnoses: (dxByEncounter.get(last.id) ?? []).map((d) => ({ code: d.stem_code, title: d.title, certainty: d.certainty ?? null })),
      medications: meds,
      assessment: w.assessment || null,
      plan: w.plan || null,
      disposition: last.disposition ?? null,
      pendingTests,
      results,
      vitals: v
        ? {
            bp: n(v.bp_systolic) != null ? `${n(v.bp_systolic)}/${n(v.bp_diastolic) ?? "?"}` : null,
            temp: n(v.temperature_c),
            weight: n(v.weight_kg),
            hr: n(v.heart_rate),
            spo2: n(v.spo2),
          }
        : null,
    }

    if (pendingTests.length) {
      alerts.push({ level: "warning", text: `${pendingTests.length} test${pendingTests.length > 1 ? "s" : ""} from the last visit still without a result` })
      workPlan.push(`Chase results: ${pendingTests.map((t) => t.name).join(", ")}`)
    }
    const abnormal = results.filter((r) => r.abnormal || r.critical)
    if (abnormal.length) {
      alerts.push({ level: abnormal.some((r) => r.critical) ? "danger" : "warning", text: `Abnormal at last visit: ${abnormal.map((r) => `${r.name} ${r.value}${r.unit ? ` ${r.unit}` : ""}`).join(", ")}` })
      workPlan.push(`Review abnormal results: ${abnormal.map((r) => r.name).join(", ")}`)
    }
    if (lastVisit.plan) workPlan.push(`Last plan: ${lastVisit.plan.slice(0, 240)}`)
    if (meds.length) workPlan.push(`Check adherence and response to: ${meds.slice(0, 4).join(", ")}`)
    if (daysAgo <= 14 && lastVisit.diagnoses.length) {
      alerts.push({ level: "info", text: `Returned within ${daysAgo} day${daysAgo === 1 ? "" : "s"}: possible treatment failure or new problem` })
      workPlan.push(`Ask whether ${lastVisit.diagnoses[0]!.title.toLowerCase()} improved on treatment`)
    }
  }

  // Vital trends across visits (one point per vitals row).
  const vpts = (pick: (v: ContinuityVitalsRow) => number | null) =>
    input.vitals.flatMap((v) => {
      const value = pick(v)
      return value == null || !v.recorded_at ? [] : [{ at: v.recorded_at, value }]
    })
  const vitalTrends = [
    series("bp_systolic", "Systolic BP", "mmHg", vpts((v) => n(v.bp_systolic)), [90, 139]),
    series("bp_diastolic", "Diastolic BP", "mmHg", vpts((v) => n(v.bp_diastolic)), [60, 89]),
    series("weight", "Weight", "kg", vpts((v) => n(v.weight_kg))),
    series("temperature", "Temperature", "°C", vpts((v) => n(v.temperature_c)), [36, 37.4]),
    series("heart_rate", "Heart rate", "/min", vpts((v) => n(v.heart_rate)), [60, 100]),
    series("spo2", "SpO₂", "%", vpts((v) => n(v.spo2)), [94, 100]),
  ].filter((s) => s.points.length > 0)

  // Lab trends: numeric results grouped by test.
  const labGroups = new Map<string, { label: string; unit: string; points: TrendPoint[] }>()
  for (const r of input.labResults) {
    const value = n(r.numeric_value ?? r.result_value ?? r.value)
    const at = r.verified_at ?? r.created_at
    if (value == null || !at || !r.test_name) continue
    const key = (r.loinc_code || r.test_name).toLowerCase()
    const g = labGroups.get(key) ?? { label: r.test_name, unit: r.unit ?? "", points: [] }
    g.points.push({ at, value, flag: r.abnormal_flag ?? r.flag ?? null })
    labGroups.set(key, g)
  }
  const labTrends = [...labGroups.entries()]
    .map(([key, g]) => series(key, g.label, g.unit, g.points))
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, 8)

  const sys = vitalTrends.find((s) => s.key === "bp_systolic")
  if (sys && sys.points.length >= 2 && sys.direction === "rising" && (sys.latest ?? 0) >= 140) {
    alerts.push({ level: "warning", text: `Systolic BP rising over ${sys.points.length} readings, now ${sys.latest}` })
    workPlan.push("Recheck BP and review antihypertensive treatment")
  }
  const wt = vitalTrends.find((s) => s.key === "weight")
  if (wt && wt.points.length >= 2) {
    const first = wt.points[0]!.value
    const lost = first > 0 ? (first - (wt.latest ?? first)) / first : 0
    if (lost >= 0.05) {
      alerts.push({ level: "warning", text: `Weight down ${Math.round(lost * 100)}% (${first} → ${wt.latest} kg)` })
      workPlan.push("Unexplained weight loss: screen for TB, HIV, diabetes and malignancy")
    }
  }
  for (const t of labTrends) {
    if (/haemoglobin|hemoglobin|^hb$/i.test(t.label) && t.direction === "falling" && t.points.length >= 2) {
      alerts.push({ level: "warning", text: `Haemoglobin falling: ${t.points[0]!.value} → ${t.latest} ${t.unit}` })
    }
  }

  const chronic = new Set([...listOf(p.chronic_conditions), ...recurringProblems.filter((r) => r.count >= 2).map((r) => r.title)])
  const allergyRows = input.allergies.map((a) => ({ allergen: a.allergen, reaction: a.reaction ?? null, severity: a.severity ?? null }))
  for (const name of listOf(p.allergies)) {
    if (!allergyRows.some((a) => a.allergen.toLowerCase() === name.toLowerCase())) allergyRows.push({ allergen: name, reaction: null, severity: null })
  }

  return {
    patient: {
      id: p.id,
      name: p.full_name ?? null,
      mrn: p.mrn ?? null,
      sex,
      ageYears: age,
      pregnant: Boolean(p.is_pregnant),
      bloodGroup: p.blood_group ?? null,
      district: p.district ?? null,
    },
    visitCount: past.length,
    firstSeen: past.length ? when(past[past.length - 1]!) : null,
    lastVisit,
    visits: past.slice(0, 10).map((e) => ({ encounterId: e.id, date: when(e), complaint: e.chief_complaint, diagnoses: (dxByEncounter.get(e.id) ?? []).map((d) => d.title) })),
    recurringProblems,
    chronicConditions: [...chronic].slice(0, 10),
    allergies: allergyRows,
    vitalTrends,
    labTrends,
    alerts,
    workPlan: workPlan.slice(0, 6),
  }
}
