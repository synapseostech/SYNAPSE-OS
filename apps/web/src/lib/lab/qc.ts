import { z } from 'zod'

/**
 * Internal quality control (Westgard multirules).
 *
 * The database is the single place the rules are evaluated
 * (`lab_qc_record`, migration 20261122140000): it locks the control, reads its
 * history and writes the run in one transaction. This module only validates
 * input and shapes stored runs for the screen; it never re-decides a status.
 */

export const QC_LEVELS = ['L1', 'L2', 'L3'] as const
export type QcLevel = (typeof QC_LEVELS)[number]

/** Roles granted lab.qc.manage by migration 20261122140000 (screen hint only). */
export const QC_MANAGE_ROLES = new Set(['lab_scientist', 'lab_admin', 'lab_manager', 'lab_supervisor', 'hospital_admin'])

export type QcStatus = 'accepted' | 'warning' | 'rejected'

export const QC_RULES: Record<string, { label: string; meaning: string; rejects: boolean }> = {
  '1_2s': { label: '1-2s', meaning: 'One control beyond 2 SD. Warning: check the other rules before reporting.', rejects: false },
  '1_3s': { label: '1-3s', meaning: 'One control beyond 3 SD. Random error: reject the run.', rejects: true },
  '2_2s': { label: '2-2s', meaning: 'Two controls beyond 2 SD on the same side (same level twice, or two levels together). Systematic error.', rejects: true },
  R_4s: { label: 'R-4s', meaning: 'One level beyond +2 SD and another beyond -2 SD in the same run. Random error.', rejects: true },
  '4_1s': { label: '4-1s', meaning: 'Four runs in a row beyond 1 SD on the same side. Systematic shift.', rejects: true },
  '10_x': { label: '10x', meaning: 'Ten runs in a row on the same side of the mean. Systematic shift or drift.', rejects: true },
}

const LOINC = z.string().trim().regex(/^\d{1,7}-\d$/, 'LOINC looks like 718-7')
const UUID = z.string().uuid()
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const qcMaterialSchema = z.object({
  loincCode: LOINC,
  analyteName: z.string().trim().min(2).max(200),
  unit: z.string().trim().max(40).nullable().optional(),
  materialName: z.string().trim().min(2).max(200),
  lotNumber: z.string().trim().min(1).max(60),
  level: z.enum(QC_LEVELS),
  targetMean: z.number().finite(),
  targetSd: z.number().finite().positive('SD must be above zero'),
  expiresOn: DAY.nullable().optional(),
  deviceId: UUID.nullable().optional(),
}).strict()

/** Lot, level and analyte are fixed once runs exist: a new lot is a new control. */
export const qcMaterialPatchSchema = z.object({
  materialName: z.string().trim().min(2).max(200),
  unit: z.string().trim().max(40).nullable(),
  targetMean: z.number().finite(),
  targetSd: z.number().finite().positive('SD must be above zero'),
  expiresOn: DAY.nullable(),
  deviceId: UUID.nullable(),
  isActive: z.boolean(),
}).partial().strict()

export const qcRunSchema = z.object({
  results: z.array(z.object({ materialId: UUID, value: z.number().finite() }).strict())
    .min(1, 'Enter at least one control value')
    .max(3, 'Record up to three levels at a time')
    .refine((list) => new Set(list.map((r) => r.materialId)).size === list.length, 'Each level once per run'),
  comment: z.string().trim().max(500).optional(),
  runAt: z.string().datetime({ offset: true }).optional(),
}).strict()

export const qcCorrectiveActionSchema = z.object({
  action: z.string().trim().min(5, 'Describe what was done').max(1000),
}).strict()

export type QcMaterialInput = z.infer<typeof qcMaterialSchema>
export type QcMaterialPatch = z.infer<typeof qcMaterialPatchSchema>

export function qcMaterialToRow(input: Partial<QcMaterialInput> & QcMaterialPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  if (input.loincCode !== undefined) row.loinc_code = input.loincCode
  if (input.analyteName !== undefined) row.analyte_name = input.analyteName
  if (input.unit !== undefined) row.unit = input.unit || null
  if (input.materialName !== undefined) row.material_name = input.materialName
  if (input.lotNumber !== undefined) row.lot_number = input.lotNumber
  if (input.level !== undefined) row.level = input.level
  if (input.targetMean !== undefined) row.target_mean = input.targetMean
  if (input.targetSd !== undefined) row.target_sd = input.targetSd
  if (input.expiresOn !== undefined) row.expires_on = input.expiresOn || null
  if (input.deviceId !== undefined) row.device_id = input.deviceId || null
  if (input.isActive !== undefined) row.is_active = input.isActive
  return row
}

/** Map a lab_qc_record error (LB400/LB404/LB409) to an HTTP status and a message for the bench. */
export function qcRecordError(error: { message?: string; code?: string }): { status: number; message: string } {
  const raw = String(error.message ?? '')
  const status = error.code === 'LB400' ? 400 : error.code === 'LB404' ? 404 : error.code === 'LB409' ? 409 : 500
  if (status === 500) return { status, message: 'Could not save the control run. Try again.' }
  if (status === 404) return { status, message: 'Control not found' }
  const detail = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : ''
  const fallback: Record<string, string> = {
    LAB_QC_INCOMPLETE: 'Enter the control values',
    LAB_QC_DUPLICATE_LEVEL: 'Each level once per run',
    LAB_QC_FUTURE_RUN: 'The run time cannot be in the future',
  }
  const code = raw.split(':')[0] ?? ''
  return { status, message: detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : fallback[code] ?? 'The control run was refused' }
}

export type QcRunRow = {
  id: string
  material_id: string
  batch_id: string
  value: number | string
  target_mean: number | string
  target_sd: number | string
  z_score: number | string
  rules: string[] | null
  status: QcStatus
  comment: string | null
  corrective_action: string | null
  run_at: string
}

export type QcMaterialRow = {
  id: string
  loinc_code: string
  analyte_name: string
  unit: string | null
  material_name: string
  lot_number: string
  level: QcLevel
  target_mean: number | string
  target_sd: number | string
  expires_on: string | null
  device_id: string | null
  is_active: boolean
  last_run_at: string | null
  last_run_status: QcStatus | null
}

/** z-score for a value typed on the bench, before it is saved (display only). */
export function previewZ(value: number, mean: number, sd: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(mean) || !(sd > 0)) return null
  return Math.round(((value - mean) / sd) * 100) / 100
}

/**
 * Observed statistics of a control, from runs that were not rejected. Used to
 * set or review a lab's own target mean and SD (usually after 20 runs).
 */
export function qcStatistics(runs: Array<Pick<QcRunRow, 'value' | 'status'>>): { n: number; mean: number | null; sd: number | null; cv: number | null } {
  const values = runs.filter((r) => r.status !== 'rejected').map((r) => Number(r.value)).filter(Number.isFinite)
  const n = values.length
  if (!n) return { n, mean: null, sd: null, cv: null }
  const mean = values.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { n, mean: round(mean, 4), sd: null, cv: null }
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
  return { n, mean: round(mean, 4), sd: round(sd, 4), cv: mean !== 0 ? round((sd / Math.abs(mean)) * 100, 2) : null }
}

/** Levey-Jennings points, oldest first, z clamped to ±4 so an outlier stays on the chart. */
export function leveyJenningsPoints(runs: QcRunRow[]): Array<{ id: string; runAt: string; value: number; z: number; plotZ: number; status: QcStatus; rules: string[] }> {
  return [...runs]
    .sort((a, b) => a.run_at.localeCompare(b.run_at) || a.id.localeCompare(b.id))
    .map((r) => {
      const z = Number(r.z_score)
      return { id: r.id, runAt: r.run_at, value: Number(r.value), z, plotZ: Math.max(-4, Math.min(4, z)), status: r.status, rules: r.rules ?? [] }
    })
}

export type QcAnalyteSummary = {
  loincCode: string
  analyteName: string
  unit: string | null
  locked: boolean
  failedLevels: string[]
  levels: QcMaterialRow[]
  lastRunAt: string | null
  /** No control has been run on this analyte today (lab-local day). */
  notRunToday: boolean
  expiringSoon: string[]
}

/** One row per analyte: is it locked, has QC been run today, which lots expire soon. */
export function summariseQc(materials: QcMaterialRow[], now: Date = new Date(), timeZone = 'Africa/Kampala'): QcAnalyteSummary[] {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone })
  const today = day(now)
  const soon = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const byLoinc = new Map<string, QcMaterialRow[]>()
  for (const m of materials) {
    if (!m.is_active) continue
    const list = byLoinc.get(m.loinc_code) ?? []
    list.push(m)
    byLoinc.set(m.loinc_code, list)
  }
  return [...byLoinc.entries()].map(([loincCode, levels]) => {
    levels.sort((a, b) => a.level.localeCompare(b.level) || a.lot_number.localeCompare(b.lot_number))
    const failed = levels.filter((m) => m.last_run_status === 'rejected')
    const lastRunAt = levels.map((m) => m.last_run_at).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null
    return {
      loincCode,
      analyteName: levels[0]!.analyte_name,
      unit: levels[0]!.unit,
      locked: failed.length > 0,
      failedLevels: failed.map((m) => m.level),
      levels,
      lastRunAt,
      notRunToday: !lastRunAt || day(new Date(lastRunAt)) !== today,
      expiringSoon: levels.filter((m) => m.expires_on && m.expires_on <= soon).map((m) => `${m.level} lot ${m.lot_number}`),
    }
  }).sort((a, b) => Number(b.locked) - Number(a.locked) || a.analyteName.localeCompare(b.analyteName))
}

function round(value: number, places: number) {
  const f = 10 ** places
  return Math.round(value * f) / f
}
