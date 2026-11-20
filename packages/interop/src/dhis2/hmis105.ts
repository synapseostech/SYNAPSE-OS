/**
 * Uganda HMIS 105 (OPD monthly report), diagnosis section, built from coded
 * ICD-11 diagnoses.
 *
 * The category names follow the MoH HMIS 105 OPD diagnosis list. MoH revises
 * the tool; the facility should confirm the names against the form it files
 * this month. Each category is a set of WHO ICD-11 code roots: a diagnosis
 * belongs to the first category with a root it starts with. Every root is
 * checked against the WHO index by hmis105.test.ts.
 *
 * Age bands and sex follow the HMIS 105 columns: 0-28 days, 29 days-4 years,
 * 5-59 years, 60 years and over; male and female.
 *
 * Pure: the route loads the month's diagnoses (tenant-scoped) and passes rows in.
 */

export type Hmis105Category = { key: string; label: string; group: string; roots: string[]; notifiable?: boolean }

/** Order matters: specific categories before the general ones that would also match. */
export const HMIS105_OPD_CATEGORIES: Hmis105Category[] = [
  // Notifiable conditions (also reported weekly through IDSR)
  { key: "cholera", label: "Cholera", group: "Notifiable", roots: ["1A00"], notifiable: true },
  { key: "dysentery", label: "Dysentery", group: "Notifiable", roots: ["1A02", "1A36.00"], notifiable: true },
  { key: "meningitis", label: "Bacterial meningitis", group: "Notifiable", roots: ["1D01.0"], notifiable: true },
  { key: "measles", label: "Measles", group: "Notifiable", roots: ["1F03"], notifiable: true },
  { key: "tetanus", label: "Tetanus", group: "Notifiable", roots: ["1C13", "1C15"], notifiable: true },
  { key: "rabies", label: "Animal bites / suspected rabies", group: "Notifiable", roots: ["1C82"], notifiable: true },
  { key: "plague", label: "Plague", group: "Notifiable", roots: ["1B93"], notifiable: true },
  { key: "yellow_fever", label: "Yellow fever", group: "Notifiable", roots: ["1D47"], notifiable: true },
  { key: "vhf", label: "Viral haemorrhagic fevers (Ebola, Marburg…)", group: "Notifiable", roots: ["1D60", "1D61"], notifiable: true },
  { key: "typhoid", label: "Typhoid fever", group: "Notifiable", roots: ["1A07"], notifiable: true },
  { key: "covid", label: "COVID-19", group: "Notifiable", roots: ["RA01"], notifiable: true },

  // Other communicable diseases
  { key: "malaria_confirmed", label: "Malaria (confirmed)", group: "Communicable", roots: ["1F40", "1F41", "1F42", "1F43", "1F44"] },
  { key: "malaria_presumed", label: "Malaria (not confirmed)", group: "Communicable", roots: ["1F45", "1F4Z"] },
  { key: "pneumonia", label: "Pneumonia", group: "Communicable", roots: ["CA40"] },
  { key: "cough_cold", label: "No pneumonia: cough or cold", group: "Communicable", roots: ["CA00", "CA07", "CA42"] },
  { key: "influenza", label: "Influenza-like illness", group: "Communicable", roots: ["1E30", "1E31", "1E32"] },
  { key: "diarrhoea_acute", label: "Diarrhoea: acute", group: "Communicable", roots: ["1A40", "1A0", "1A2", "1A3", "ME05.1"] },
  { key: "tuberculosis", label: "Tuberculosis", group: "Communicable", roots: ["1B10", "1B11", "1B12", "1B13", "1B14"] },
  { key: "hiv", label: "HIV disease", group: "Communicable", roots: ["1C60", "1C61", "1C62"] },
  { key: "hepatitis_b", label: "Hepatitis B", group: "Communicable", roots: ["1E51.0"] },
  { key: "uti", label: "Urinary tract infection", group: "Communicable", roots: ["GC08", "GC00", "GB51"] },
  { key: "sti_discharge", label: "STI: urethral / vaginal discharge", group: "Communicable", roots: ["1A70", "GC02"] },
  { key: "pid", label: "Pelvic inflammatory disease", group: "Communicable", roots: ["GA05"] },
  { key: "ear_infection", label: "Ear infection", group: "Communicable", roots: ["AB00", "AB01"] },
  { key: "eye_infection", label: "Eye infection / conjunctivitis", group: "Communicable", roots: ["9A60"] },
  { key: "intestinal_worms", label: "Intestinal worms", group: "Communicable", roots: ["1F62", "1F65", "1F68", "1F6B", "1F6G", "1F76", "1F90.2", "1F9Z"] },
  { key: "skin", label: "Skin diseases", group: "Communicable", roots: ["1B70", "1B72", "1G04", "1F28"] },
  { key: "sepsis", label: "Sepsis", group: "Communicable", roots: ["1G40", "1G41"] },

  // Non-communicable diseases
  { key: "hypertension", label: "Hypertension", group: "Non-communicable", roots: ["BA00", "BA01", "BA02", "BA03", "BA04"] },
  { key: "diabetes", label: "Diabetes mellitus", group: "Non-communicable", roots: ["5A10", "5A11", "5A13", "5A14", "5A2"] },
  { key: "asthma", label: "Asthma", group: "Non-communicable", roots: ["CA23"] },
  { key: "sickle_cell", label: "Sickle cell disease", group: "Non-communicable", roots: ["3A51"] },
  { key: "anaemia", label: "Anaemia", group: "Non-communicable", roots: ["3A"] },
  { key: "epilepsy", label: "Epilepsy", group: "Non-communicable", roots: ["8A60", "8A61", "8A6Z"] },
  { key: "gi_noninfective", label: "Gastro-intestinal disorders (non-infective)", group: "Non-communicable", roots: ["DA22", "DA42", "DA60", "DA61", "DA62", "DA63"] },
  { key: "heart_failure", label: "Heart failure", group: "Non-communicable", roots: ["BD1"] },
  { key: "mental", label: "Mental, neurological and substance use", group: "Non-communicable", roots: ["6"] },
  { key: "injuries", label: "Injuries", group: "Injuries", roots: ["N"] },
]

export const HMIS105_AGE_BANDS = [
  { key: "0_28d", label: "0–28 days" },
  { key: "29d_4y", label: "29 days–4 years" },
  { key: "5_59y", label: "5–59 years" },
  { key: "60y", label: "60+ years" },
] as const
export type AgeBand = (typeof HMIS105_AGE_BANDS)[number]["key"] | "unknown"

export function hmis105CategoryFor(code: string): Hmis105Category | null {
  const c = String(code ?? "").trim().toUpperCase()
  if (!c) return null
  return HMIS105_OPD_CATEGORIES.find((cat) => cat.roots.some((r) => c === r || c.startsWith(r))) ?? null
}

export function ageBandAt(dob: string | null | undefined, at: string): AgeBand {
  if (!dob) return "unknown"
  const born = new Date(dob).getTime()
  const seen = new Date(at).getTime()
  if (!Number.isFinite(born) || !Number.isFinite(seen) || seen < born) return "unknown"
  const days = (seen - born) / 86_400_000
  if (days <= 28) return "0_28d"
  const years = days / 365.25
  if (years < 5) return "29d_4y"
  if (years < 60) return "5_59y"
  return "60y"
}

export type Hmis105DiagnosisRow = {
  encounter_id: string
  stem_code: string
  certainty?: string | null
  visit_date: string
  dob?: string | null
  sex?: string | null
}

export type Hmis105Cell = { M: number; F: number; U: number }
export type Hmis105Row = {
  key: string
  label: string
  group: string
  notifiable: boolean
  total: number
  bands: Record<AgeBand, Hmis105Cell>
}

export type Hmis105Report = {
  period: string
  rows: Hmis105Row[]
  otherDiagnoses: { code: string; count: number }[]
  totals: { cases: number; encounters: number; unknownAgeOrSex: number; excludedDifferential: number }
}

const emptyBands = (): Record<AgeBand, Hmis105Cell> => ({
  "0_28d": { M: 0, F: 0, U: 0 },
  "29d_4y": { M: 0, F: 0, U: 0 },
  "5_59y": { M: 0, F: 0, U: 0 },
  "60y": { M: 0, F: 0, U: 0 },
  unknown: { M: 0, F: 0, U: 0 },
})

function sexKey(s: string | null | undefined): "M" | "F" | "U" {
  const v = String(s ?? "").trim().toLowerCase()
  if (v === "m" || v === "male") return "M"
  if (v === "f" || v === "female") return "F"
  return "U"
}

/**
 * One case per encounter per category: two malaria codes on the same visit
 * count once. Differential (rule-out) diagnoses are not cases and are left out.
 */
export function buildHmis105Report(period: string, rows: Hmis105DiagnosisRow[]): Hmis105Report {
  const byKey = new Map<string, Hmis105Row>()
  for (const cat of HMIS105_OPD_CATEGORIES) {
    byKey.set(cat.key, { key: cat.key, label: cat.label, group: cat.group, notifiable: Boolean(cat.notifiable), total: 0, bands: emptyBands() })
  }
  const seen = new Set<string>()
  const other = new Map<string, number>()
  const encounters = new Set<string>()
  let excludedDifferential = 0
  let unknownAgeOrSex = 0

  for (const r of rows) {
    if (String(r.certainty ?? "").toLowerCase() === "differential") {
      excludedDifferential += 1
      continue
    }
    encounters.add(r.encounter_id)
    const cat = hmis105CategoryFor(r.stem_code)
    if (!cat) {
      const k = `${r.encounter_id}|other|${r.stem_code}`
      if (!seen.has(k)) {
        seen.add(k)
        other.set(r.stem_code, (other.get(r.stem_code) ?? 0) + 1)
      }
      continue
    }
    const k = `${r.encounter_id}|${cat.key}`
    if (seen.has(k)) continue
    seen.add(k)
    const band = ageBandAt(r.dob, r.visit_date)
    const sex = sexKey(r.sex)
    if (band === "unknown" || sex === "U") unknownAgeOrSex += 1
    const row = byKey.get(cat.key)!
    row.bands[band][sex] += 1
    row.total += 1
  }

  const reportRows = [...byKey.values()]
  return {
    period,
    rows: reportRows,
    otherDiagnoses: [...other.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    totals: { cases: reportRows.reduce((a, r) => a + r.total, 0), encounters: encounters.size, unknownAgeOrSex, excludedDifferential },
  }
}

/** CSV in the HMIS 105 column order, for the records officer to transcribe or upload. */
export function hmis105Csv(report: Hmis105Report): string {
  const header = ["Group", "Diagnosis", ...HMIS105_AGE_BANDS.flatMap((b) => [`${b.label} M`, `${b.label} F`]), "Age or sex not recorded", "Total"]
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.map(esc).join(",")]
  for (const r of report.rows) {
    const unknown = r.bands.unknown.M + r.bands.unknown.F + r.bands.unknown.U + HMIS105_AGE_BANDS.reduce((a, b) => a + r.bands[b.key].U, 0)
    lines.push([r.group, r.label, ...HMIS105_AGE_BANDS.flatMap((b) => [r.bands[b.key].M, r.bands[b.key].F]), unknown, r.total].map(esc).join(","))
  }
  return `${lines.join("\n")}\n`
}
