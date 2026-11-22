/**
 * Facility-level surveillance from coded diagnoses: weekly counts per HMIS
 * group (epidemiological weeks, Monday start, Kampala time), alerts and a
 * district breakdown.
 *
 * Alert rules (decision support for the surveillance focal person, not a
 * replacement for the IDSR guidelines):
 *  - Immediately notifiable groups (cholera, measles, meningitis, VHF, plague,
 *    yellow fever, rabies, tetanus, COVID-19): any case this week.
 *  - Every other group with at least 8 prior weeks of data: this week's count
 *    above the mean + 2 standard deviations of the previous 8 weeks, and at
 *    least 5 cases (so 0 -> 2 is not an "epidemic").
 *
 * Pure: aggregate counts only, no identifiers.
 */
import { HMIS105_OPD_CATEGORIES, hmis105CategoryFor, type Hmis105DiagnosisRow } from "./hmis105"

const KAMPALA_OFFSET_MS = 3 * 3_600_000
const DAY = 86_400_000

export const MIN_WEEKS = 4
export const MAX_WEEKS = 52

const IMMEDIATE = new Set(["cholera", "measles", "meningitis", "vhf", "plague", "yellow_fever", "rabies", "tetanus", "covid"])

/** Monday 00:00 Kampala of the week containing `iso`, as a YYYY-MM-DD key. */
export function epiWeekStart(iso: string): string {
  const local = new Date(new Date(iso).getTime() + KAMPALA_OFFSET_MS)
  const dow = (local.getUTCDay() + 6) % 7 // Monday = 0
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow))
  return monday.toISOString().slice(0, 10)
}

/** ISO-8601 week label, e.g. "2026-W47". */
export function epiWeekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`)
  const thursday = new Date(d.getTime() + 3 * DAY)
  const year = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY)
  const week = Math.round((d.getTime() - week1Monday.getTime()) / (7 * DAY)) + 1
  return `${year}-W${String(week).padStart(2, "0")}`
}

export type SurveillanceRow = Hmis105DiagnosisRow & { district?: string | null }

export type SurveillanceSeries = { key: string; label: string; group: string; notifiable: boolean; counts: number[]; total: number; thisWeek: number; lastWeek: number }
export type SurveillanceAlert = { key: string; label: string; level: "immediate" | "threshold"; thisWeek: number; threshold: number | null; message: string }

export type SurveillanceReport = {
  weeks: { start: string; label: string }[]
  series: SurveillanceSeries[]
  alerts: SurveillanceAlert[]
  districts: { district: string; total: number; byCategory: { key: string; count: number }[] }[]
  totals: { cases: number; thisWeek: number; lastWeek: number }
}

export function buildSurveillance(rows: SurveillanceRow[], opts: { weeks?: number; now?: Date } = {}): SurveillanceReport {
  // Bounded explicitly: the week count sizes arrays, so it must never come
  // through as NaN or a huge number.
  const requested = typeof opts.weeks === "number" && Number.isFinite(opts.weeks) ? Math.trunc(opts.weeks) : 12
  let nWeeks = 12
  if (requested >= MIN_WEEKS && requested <= MAX_WEEKS) nWeeks = requested
  else if (requested > MAX_WEEKS) nWeeks = MAX_WEEKS
  else nWeeks = MIN_WEEKS
  const now = opts.now ?? new Date()
  const current = epiWeekStart(now.toISOString())
  const weeks: { start: string; label: string }[] = []
  for (let i = nWeeks - 1; i >= 0; i -= 1) {
    const start = new Date(new Date(`${current}T00:00:00Z`).getTime() - i * 7 * DAY).toISOString().slice(0, 10)
    weeks.push({ start, label: epiWeekLabel(start) })
  }
  const index = new Map(weeks.map((w, i) => [w.start, i]))

  const counts = new Map<string, number[]>()
  const districtCounts = new Map<string, Map<string, number>>()
  const seen = new Set<string>()
  for (const r of rows) {
    if (String(r.certainty ?? "").toLowerCase() === "differential") continue
    const cat = hmis105CategoryFor(r.stem_code)
    if (!cat) continue
    const k = `${r.encounter_id}|${cat.key}`
    if (seen.has(k)) continue
    seen.add(k)
    const wi = index.get(epiWeekStart(r.visit_date))
    if (wi == null) continue
    const arr = counts.get(cat.key) ?? weeks.map(() => 0)
    arr[wi] = (arr[wi] ?? 0) + 1
    counts.set(cat.key, arr)
    const district = (r.district ?? "").trim() || "Not recorded"
    const dm = districtCounts.get(district) ?? new Map<string, number>()
    dm.set(cat.key, (dm.get(cat.key) ?? 0) + 1)
    districtCounts.set(district, dm)
  }

  const series: SurveillanceSeries[] = []
  for (const cat of HMIS105_OPD_CATEGORIES) {
    const c = counts.get(cat.key)
    if (!c) continue
    series.push({
      key: cat.key,
      label: cat.label,
      group: cat.group,
      notifiable: Boolean(cat.notifiable),
      counts: c,
      total: c.reduce((a, b) => a + b, 0),
      thisWeek: c[nWeeks - 1] ?? 0,
      lastWeek: c[nWeeks - 2] ?? 0,
    })
  }
  series.sort((a, b) => b.total - a.total)

  const alerts: SurveillanceAlert[] = []
  for (const s of series) {
    if (IMMEDIATE.has(s.key) && s.thisWeek > 0) {
      alerts.push({ key: s.key, label: s.label, level: "immediate", thisWeek: s.thisWeek, threshold: null, message: `${s.thisWeek} case${s.thisWeek > 1 ? "s" : ""} this week. Immediately notifiable: report to the district surveillance focal person within 24 hours.` })
      continue
    }
    const baseline = s.counts.slice(Math.max(0, nWeeks - 9), nWeeks - 1)
    if (baseline.length < 8) continue
    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length
    const sd = Math.sqrt(baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length)
    const threshold = Math.ceil(mean + 2 * sd)
    if (s.thisWeek >= 5 && s.thisWeek > threshold) {
      alerts.push({ key: s.key, label: s.label, level: "threshold", thisWeek: s.thisWeek, threshold, message: `${s.thisWeek} cases this week, above the usual range (threshold ${threshold}, from the previous 8 weeks). Investigate for a possible outbreak.` })
    }
  }

  const districts = [...districtCounts.entries()]
    .map(([district, m]) => ({
      district,
      total: [...m.values()].reduce((a, b) => a + b, 0),
      byCategory: [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total)

  return {
    weeks,
    series,
    alerts,
    districts,
    totals: {
      cases: series.reduce((a, s) => a + s.total, 0),
      thisWeek: series.reduce((a, s) => a + s.thisWeek, 0),
      lastWeek: series.reduce((a, s) => a + s.lastWeek, 0),
    },
  }
}
