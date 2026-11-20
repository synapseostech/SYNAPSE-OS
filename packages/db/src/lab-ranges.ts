/**
 * Reference ranges from lab_reference_ranges rows, ordered so the tenant's own
 * interval wins over the national pack, and the patient facts interpretResult
 * needs (sex code, age in years).
 */

import type { LabReferenceRange } from "./lab-workflow"

export type LabReferenceRangeRow = {
  tenant_id?: string | null
  loinc_code: string
  test_name: string
  unit: string
  sex?: string | null
  age_min_years?: number | string | null
  age_max_years?: number | string | null
  low: number | string
  high: number | string
  critical_low?: number | string | null
  critical_high?: number | string | null
}

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function normaliseLabSex(value: unknown): "M" | "F" | "I" | "U" | null {
  const s = String(value ?? "").trim().toLowerCase()
  if (!s) return null
  if (s === "m" || s === "male" || s === "man") return "M"
  if (s === "f" || s === "female" || s === "woman") return "F"
  if (s === "i" || s === "intersex" || s === "other") return "I"
  return "U"
}

export function ageInYears(dob: string | null | undefined, at: Date = new Date()): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  if (Number.isNaN(birth.getTime()) || birth > at) return null
  let years = at.getUTCFullYear() - birth.getUTCFullYear()
  const beforeBirthday =
    at.getUTCMonth() < birth.getUTCMonth() ||
    (at.getUTCMonth() === birth.getUTCMonth() && at.getUTCDate() < birth.getUTCDate())
  if (beforeBirthday) years -= 1
  return years
}

export function formatAge(dob: string | null | undefined, at: Date = new Date()): string | null {
  const years = ageInYears(dob, at)
  if (years == null) return null
  if (years >= 2) return `${years} y`
  const birth = new Date(String(dob))
  const months = (at.getUTCFullYear() - birth.getUTCFullYear()) * 12 + at.getUTCMonth() - birth.getUTCMonth()
  return `${Math.max(0, months)} m`
}

/**
 * Convert rows to the engine's shape. Tenant rows come first, then sex- and
 * age-specific rows before general ones, so interpretResult's first match is
 * the most specific interval that applies.
 */
export function rowsToReferenceRanges(rows: LabReferenceRangeRow[] | null | undefined, tenantId?: string | null): LabReferenceRange[] {
  const list = (rows ?? []).filter((row) => !row.tenant_id || !tenantId || row.tenant_id === tenantId)
  const score = (row: LabReferenceRangeRow) =>
    (row.tenant_id ? 0 : 100) + (row.sex ? 0 : 10) + (row.age_min_years != null || row.age_max_years != null ? 0 : 1)
  return [...list]
    .sort((a, b) => score(a) - score(b))
    .flatMap((row) => {
      const low = num(row.low)
      const high = num(row.high)
      if (low == null || high == null) return []
      const sex = row.sex ? normaliseLabSex(row.sex) : null
      return [{
        loincCode: row.loinc_code,
        testName: row.test_name,
        unit: row.unit,
        sex: sex === "U" ? null : sex,
        ageMinYears: num(row.age_min_years),
        ageMaxYears: num(row.age_max_years),
        low,
        high,
        criticalLow: num(row.critical_low),
        criticalHigh: num(row.critical_high),
      }]
    })
}
