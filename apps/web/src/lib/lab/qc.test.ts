import { describe, expect, it } from 'vitest'
import {
  leveyJenningsPoints, previewZ, qcCorrectiveActionSchema, qcMaterialPatchSchema, qcMaterialSchema, qcMaterialToRow,
  qcRecordError, qcRunSchema, qcStatistics, summariseQc, type QcMaterialRow, type QcRunRow,
} from './qc'

const M1 = '0a000000-0000-4000-8000-000000000001'
const M2 = '0a000000-0000-4000-8000-000000000002'

const material = (o: Partial<QcMaterialRow> = {}): QcMaterialRow => ({
  id: M1, loinc_code: '718-7', analyte_name: 'Haemoglobin', unit: 'g/dL', material_name: 'Haem control', lot_number: 'H1', level: 'L1',
  target_mean: 6, target_sd: 0.2, expires_on: null, device_id: null, is_active: true, last_run_at: null, last_run_status: null, ...o,
})
const run = (o: Partial<QcRunRow> = {}): QcRunRow => ({
  id: 'r1', material_id: M1, batch_id: 'b1', value: 6, target_mean: 6, target_sd: 0.2, z_score: 0, rules: [], status: 'accepted',
  comment: null, corrective_action: null, run_at: '2026-11-20T08:00:00Z', ...o,
})

describe('QC input', () => {
  it('a control needs a LOINC, a level, and an SD above zero', () => {
    const ok = { loincCode: '718-7', analyteName: 'Haemoglobin', materialName: 'Haem control', lotNumber: 'H1', level: 'L1', targetMean: 6, targetSd: 0.2 }
    expect(qcMaterialSchema.safeParse(ok).success).toBe(true)
    expect(qcMaterialSchema.safeParse({ ...ok, targetSd: 0 }).success).toBe(false)
    expect(qcMaterialSchema.safeParse({ ...ok, loincCode: 'HB' }).success).toBe(false)
    expect(qcMaterialSchema.safeParse({ ...ok, level: 'L4' }).success).toBe(false)
    expect(qcMaterialSchema.safeParse({ ...ok, tenantId: 'x' }).success).toBe(false)
  })

  it('lot, level and analyte cannot be changed after set-up', () => {
    expect(qcMaterialPatchSchema.safeParse({ targetMean: 6.1 }).success).toBe(true)
    expect(qcMaterialPatchSchema.safeParse({ lotNumber: 'H2' }).success).toBe(false)
    expect(qcMaterialPatchSchema.safeParse({ level: 'L2' }).success).toBe(false)
    expect(qcMaterialPatchSchema.safeParse({ loincCode: '2345-7' }).success).toBe(false)
  })

  it('a run has one to three distinct levels with numeric values', () => {
    expect(qcRunSchema.safeParse({ results: [{ materialId: M1, value: 6.1 }, { materialId: M2, value: 12 }] }).success).toBe(true)
    expect(qcRunSchema.safeParse({ results: [] }).success).toBe(false)
    expect(qcRunSchema.safeParse({ results: [{ materialId: M1, value: 6 }, { materialId: M1, value: 6.1 }] }).success).toBe(false)
    expect(qcRunSchema.safeParse({ results: [{ materialId: M1, value: Number.NaN }] }).success).toBe(false)
    expect(qcRunSchema.safeParse({ results: Array.from({ length: 4 }, (_, i) => ({ materialId: `0a000000-0000-4000-8000-00000000000${i}`, value: 1 })) }).success).toBe(false)
  })

  it('a corrective action says what was done', () => {
    expect(qcCorrectiveActionSchema.safeParse({ action: 'ok' }).success).toBe(false)
    expect(qcCorrectiveActionSchema.safeParse({ action: 'Recalibrated and reran' }).success).toBe(true)
  })

  it('maps camelCase input to columns, only what was given', () => {
    expect(qcMaterialToRow({ targetSd: 0.3, expiresOn: null, isActive: false })).toEqual({ target_sd: 0.3, expires_on: null, is_active: false })
  })
})

describe('qcRecordError', () => {
  it('turns database refusals into bench messages and statuses', () => {
    expect(qcRecordError({ code: 'LB409', message: 'LAB_QC_LOT_EXPIRED: lot H1 of Haemoglobin L1 expired on 2026-11-01' }))
      .toEqual({ status: 409, message: 'Lot H1 of Haemoglobin L1 expired on 2026-11-01' })
    expect(qcRecordError({ code: 'LB400', message: 'LAB_QC_DUPLICATE_LEVEL' })).toEqual({ status: 400, message: 'Each level once per run' })
    expect(qcRecordError({ code: 'LB404', message: 'LAB_QC_MATERIAL_NOT_FOUND' }).status).toBe(404)
    expect(qcRecordError({ code: '42P01', message: 'relation does not exist' })).toEqual({ status: 500, message: 'Could not save the control run. Try again.' })
  })
})

describe('QC statistics and charts', () => {
  it('previewZ is display-only and refuses a bad SD', () => {
    expect(previewZ(6.5, 6, 0.2)).toBe(2.5)
    expect(previewZ(6, 6, 0)).toBeNull()
  })

  it('observed mean, SD and CV leave out rejected runs', () => {
    const s = qcStatistics([run({ value: 5.8 }), run({ value: 6 }), run({ value: 6.2 }), run({ value: 9, status: 'rejected' })])
    expect(s).toEqual({ n: 3, mean: 6, sd: 0.2, cv: 3.33 })
    expect(qcStatistics([run({ value: 6 })])).toEqual({ n: 1, mean: 6, sd: null, cv: null })
    expect(qcStatistics([])).toEqual({ n: 0, mean: null, sd: null, cv: null })
  })

  it('Levey-Jennings points run oldest first and clamp outliers to ±4 SD', () => {
    const pts = leveyJenningsPoints([
      run({ id: 'b', run_at: '2026-11-21T08:00:00Z', z_score: '7.5', status: 'rejected', rules: ['1_3s'] }),
      run({ id: 'a', run_at: '2026-11-20T08:00:00Z', z_score: -1 }),
    ])
    expect(pts.map((p) => p.id)).toEqual(['a', 'b'])
    expect(pts[1]).toMatchObject({ z: 7.5, plotZ: 4, status: 'rejected', rules: ['1_3s'] })
  })
})

describe('summariseQc', () => {
  const now = new Date('2026-11-22T09:00:00Z') // 12:00 in Kampala

  it('an analyte is on hold while any active level is rejected; switched-off controls are ignored', () => {
    const rows = summariseQc([
      material({ id: M1, last_run_status: 'rejected', last_run_at: '2026-11-22T06:00:00Z' }),
      material({ id: M2, level: 'L2', last_run_status: 'accepted', last_run_at: '2026-11-22T06:00:00Z' }),
      material({ id: 'g', loinc_code: '2345-7', analyte_name: 'Glucose', last_run_status: 'rejected', is_active: false }),
    ], now)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ loincCode: '718-7', locked: true, failedLevels: ['L1'], notRunToday: false })
  })

  it('flags controls not run today (lab-local day) and lots expiring within 14 days', () => {
    const rows = summariseQc([
      material({ last_run_at: '2026-11-21T20:00:00Z', expires_on: '2026-12-01' }), // 23:00 yesterday in Kampala
      material({ id: 'g', loinc_code: '2345-7', analyte_name: 'Glucose', last_run_at: '2026-11-21T22:30:00Z' }), // 01:30 today in Kampala
    ], now)
    const hb = rows.find((r) => r.loincCode === '718-7')!
    const glu = rows.find((r) => r.loincCode === '2345-7')!
    expect(hb.notRunToday).toBe(true)
    expect(hb.expiringSoon).toEqual(['L1 lot H1'])
    expect(glu.notRunToday).toBe(false)
  })

  it('locked analytes are listed first', () => {
    const rows = summariseQc([
      material({ id: 'a', loinc_code: '1-1', analyte_name: 'Albumin' }),
      material({ id: 'z', loinc_code: '2-2', analyte_name: 'Zinc', last_run_status: 'rejected' }),
    ], now)
    expect(rows.map((r) => r.analyteName)).toEqual(['Zinc', 'Albumin'])
  })
})
