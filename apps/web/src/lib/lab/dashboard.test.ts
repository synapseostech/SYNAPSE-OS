import { describe, expect, it } from 'vitest'
import { buildCumulativeResults, buildLabDashboard, type DashboardOrderRow } from './dashboard'

const NOW = new Date('2026-11-21T09:00:00Z') // 12:00 in Kampala
const order = (o: Partial<DashboardOrderRow> & { id: string }): DashboardOrderRow => ({
  accession_number: null, test_name: 'Malaria RDT', section: 'parasitology', workflow_status: 'ORDERED', urgency: 'ROUTINE',
  ordered_at: '2026-11-21T07:00:00Z', collected_at: null, resulted_at: null, verified_at: null, rejection_reason: null,
  catalog_test_id: 'cat-mrdt', order_source: 'hospital', patient_name: 'Demo A', ...o,
})

describe('lab dashboard', () => {
  const orders = [
    order({ id: 'a', workflow_status: 'ORDERED', ordered_at: '2026-11-21T08:50:00Z' }),
    order({ id: 'b', workflow_status: 'RECEIVED', ordered_at: '2026-11-21T07:00:00Z' }), // 120 min open, target 30 → overdue
    order({ id: 'c', workflow_status: 'VERIFICATION_PENDING', urgency: 'STAT', test_name: 'Blood glucose', section: 'chemistry', catalog_test_id: 'cat-glu', ordered_at: '2026-11-21T06:00:00Z' }),
    order({ id: 'd', workflow_status: 'RELEASED', ordered_at: '2026-11-21T06:00:00Z', verified_at: '2026-11-21T06:20:00Z' }), // 20 min, within
    order({ id: 'e', workflow_status: 'RELEASED', ordered_at: '2026-11-20T06:00:00Z', verified_at: '2026-11-20T08:00:00Z' }), // 120 min, over
    order({ id: 'f', workflow_status: 'REJECTED', rejection_reason: 'HAEMOLYSED', ordered_at: '2026-11-21T05:00:00Z' }),
    order({ id: 'g', workflow_status: 'CANCELLED', ordered_at: '2026-11-19T05:00:00Z' }),
  ]
  const catalog = [{ id: 'cat-mrdt', turnaround_minutes: 30 }, { id: 'cat-glu', turnaround_minutes: 120 }]
  const d = buildLabDashboard({ orders, catalog, criticalOpen: 2, now: NOW, windowDays: 7 })

  it('counts work by stage, with STAT called out', () => {
    const byKey = Object.fromEntries(d.stages.map((s) => [s.key, s]))
    expect(byKey.collect!.count).toBe(1)
    expect(byKey.bench!.count).toBe(1)
    expect(byKey.verify).toMatchObject({ count: 1, stat: 1 })
  })

  it('measures turnaround against each test’s target', () => {
    expect(d.tat.sample).toBe(2)
    expect(d.tat.medianMinutes).toBe(20)
    expect(d.tat.p90Minutes).toBe(120)
    expect(d.tat.withinTargetPct).toBe(50)
  })

  it('lists overdue samples, most overdue first; STAT target is at most 60 min', () => {
    expect(d.overdue.map((o) => o.id)).toEqual(['c', 'b'])
    expect(d.overdueTotal).toBe(2)
    expect(d.overdue[0]).toMatchObject({ targetMinutes: 60, urgency: 'STAT', minutesOpen: 180 })
    expect(d.overdue[1]).toMatchObject({ targetMinutes: 30, minutesOpen: 120, patient: 'Demo A' })
  })

  it('summarises today in Kampala time, rejections and volume', () => {
    expect(d.today).toMatchObject({ released: 1, rejected: 1 })
    expect(d.rejections).toEqual({ total: 1, reasons: [{ reason: 'haemolysed', count: 1 }] })
    expect(d.volume).toHaveLength(7)
    expect(d.volume.at(-1)).toMatchObject({ date: '2026-11-21', released: 1 })
    expect(d.criticalOpen).toBe(2)
  })

  it('reports per-section open work and median turnaround', () => {
    const para = d.sections.find((s) => s.section === 'parasitology')!
    expect(para).toMatchObject({ open: 2, overdue: 1, releasedToday: 1, medianTatMinutes: 20 })
  })

  it('falls back to a 4-hour target for tests without one', () => {
    const x = buildLabDashboard({ orders: [order({ id: 'z', catalog_test_id: null, ordered_at: '2026-11-21T04:00:00Z' })], catalog: [], criticalOpen: 0, now: NOW })
    expect(x.overdue[0]).toMatchObject({ targetMinutes: 240, minutesOpen: 300 })
  })

  it('counts every overdue sample even when the list is capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => order({ id: `m${i}`, ordered_at: '2026-11-21T03:00:00Z', workflow_status: 'RECEIVED' }))
    const x = buildLabDashboard({ orders: many, catalog, criticalOpen: 0, now: NOW })
    expect(x.overdueTotal).toBe(40)
    expect(x.overdue).toHaveLength(25)
  })

  it('handles an empty lab', () => {
    const x = buildLabDashboard({ orders: [], catalog: [], criticalOpen: 0, now: NOW })
    expect(x.tat).toEqual({ medianMinutes: null, p90Minutes: null, withinTargetPct: null, sample: 0 })
    expect(x.overdue).toEqual([])
  })
})

describe('cumulative results', () => {
  const row = (id: string, at: string, v: string | null, extra: Record<string, unknown> = {}) => ({
    id, lab_order_id: null, loinc_code: '718-7', test_name: 'Haemoglobin', result_value: v, value: null, numeric_value: v,
    unit: 'g/dL', reference_range: '12.0-15.0', abnormal_flag: null, is_critical: false, status: 'RELEASED', verified_at: at, created_at: at, ...extra,
  })

  it('groups by test, oldest first, with a direction', () => {
    const s = buildCumulativeResults([row('3', '2026-11-20', '8.9', { abnormal_flag: 'L' }), row('1', '2026-06-01', '12.4'), row('2', '2026-09-01', '10.8')])
    expect(s).toHaveLength(1)
    expect(s[0]!.points.map((p) => p.value)).toEqual(['12.4', '10.8', '8.9'])
    expect(s[0]!.trend).toBe('falling')
    expect(s[0]!.points[2]!.flag).toBe('L')
  })

  it('leaves out results that are not verified', () => {
    const s = buildCumulativeResults([row('1', '2026-06-01', '12.4', { status: 'RESULT_ENTERED', verified_at: null })])
    expect(s).toEqual([])
  })

  it('marks text results so they are not charted', () => {
    const s = buildCumulativeResults([
      row('1', '2026-06-01', 'Positive', { loinc_code: '58413-6', test_name: 'Malaria RDT', numeric_value: null }),
      row('2', '2026-09-01', 'Negative', { loinc_code: '58413-6', test_name: 'Malaria RDT', numeric_value: null }),
    ])
    expect(s[0]!.trend).toBe('text')
  })
})
