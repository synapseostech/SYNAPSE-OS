/**
 * Lab dashboard figures from a bounded window of order rows. Pure: the route
 * loads the rows (tenant-scoped) and this turns them into what the bench and
 * the lab manager watch: work by stage and section, turnaround against each
 * test's target, overdue samples, rejections and volume.
 */

export type DashboardOrderRow = {
  id: string
  accession_number: string | null
  test_name: string | null
  section: string | null
  workflow_status: string | null
  urgency: string | null
  ordered_at: string | null
  collected_at: string | null
  resulted_at: string | null
  verified_at: string | null
  rejection_reason: string | null
  catalog_test_id: string | null
  order_source: string | null
  patient_name?: string | null
}

export type DashboardCatalogRow = { id: string; turnaround_minutes: number | null }

export const OPEN_STAGES = [
  'ORDERED',
  'COLLECTION_PENDING',
  'COLLECTED',
  'IN_TRANSIT',
  'RECEIVED',
  'PROCESSING',
  'RESULT_ENTERED',
  'VERIFICATION_PENDING',
] as const

export const STAGE_GROUPS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'collect', label: 'To collect', statuses: ['ORDERED', 'COLLECTION_PENDING'] },
  { key: 'receive', label: 'To receive', statuses: ['COLLECTED', 'IN_TRANSIT'] },
  { key: 'bench', label: 'On the bench', statuses: ['RECEIVED', 'PROCESSING'] },
  { key: 'verify', label: 'To verify', statuses: ['RESULT_ENTERED', 'VERIFICATION_PENDING'] },
  { key: 'release', label: 'Verified, not released', statuses: ['VERIFIED'] },
]

/** Default target when a test has no turnaround in the catalogue. */
export const DEFAULT_TAT_MINUTES = 240
const STAT_TAT_MINUTES = 60

export type LabDashboard = {
  generatedAt: string
  windowDays: number
  stages: { key: string; label: string; count: number; stat: number }[]
  sections: { section: string; open: number; overdue: number; releasedToday: number; medianTatMinutes: number | null }[]
  today: { ordered: number; released: number; rejected: number; stat: number }
  tat: { medianMinutes: number | null; p90Minutes: number | null; withinTargetPct: number | null; sample: number }
  /** All overdue samples; `overdue` lists the 25 most late. */
  overdueTotal: number
  overdue: { id: string; accession: string | null; test: string; section: string; stage: string; urgency: string; minutesOpen: number; targetMinutes: number; patient: string | null }[]
  rejections: { total: number; reasons: { reason: string; count: number }[] }
  volume: { date: string; ordered: number; released: number }[]
  topTests: { test: string; count: number }[]
  criticalOpen: number
}

const MIN = 60_000

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const d = (new Date(b).getTime() - new Date(a).getTime()) / MIN
  return Number.isFinite(d) && d >= 0 ? d : null
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[idx]!)
}

/** Local calendar day in the facility's timezone (Uganda is UTC+3). */
function dayKey(iso: string, offsetMinutes: number): string {
  return new Date(new Date(iso).getTime() + offsetMinutes * MIN).toISOString().slice(0, 10)
}

export function buildLabDashboard(input: {
  orders: DashboardOrderRow[]
  catalog: DashboardCatalogRow[]
  criticalOpen: number
  now?: Date
  windowDays?: number
  utcOffsetMinutes?: number
}): LabDashboard {
  const now = input.now ?? new Date()
  const windowDays = input.windowDays ?? 14
  const offset = input.utcOffsetMinutes ?? 180
  const todayKey = dayKey(now.toISOString(), offset)
  const target = new Map(input.catalog.map((c) => [c.id, c.turnaround_minutes ?? DEFAULT_TAT_MINUTES]))
  const targetFor = (o: DashboardOrderRow) =>
    o.urgency === 'STAT' ? Math.min(STAT_TAT_MINUTES, target.get(o.catalog_test_id ?? '') ?? DEFAULT_TAT_MINUTES) : target.get(o.catalog_test_id ?? '') ?? DEFAULT_TAT_MINUTES
  const status = (o: DashboardOrderRow) => (o.workflow_status ?? 'ORDERED').toUpperCase()
  const isOpen = (o: DashboardOrderRow) => (OPEN_STAGES as readonly string[]).includes(status(o))

  const stages = STAGE_GROUPS.map((g) => {
    const rows = input.orders.filter((o) => g.statuses.includes(status(o)))
    return { key: g.key, label: g.label, count: rows.length, stat: rows.filter((o) => o.urgency === 'STAT').length }
  })

  const tats: { section: string; minutes: number; target: number; day: string }[] = []
  for (const o of input.orders) {
    const m = minutesBetween(o.ordered_at, o.verified_at)
    if (m == null || !o.verified_at) continue
    tats.push({ section: o.section ?? 'general', minutes: m, target: targetFor(o), day: dayKey(o.verified_at, offset) })
  }
  const sortedTat = tats.map((t) => t.minutes).sort((a, b) => a - b)

  const overdueAll = input.orders
    .filter(isOpen)
    .map((o) => {
      const open = minutesBetween(o.ordered_at, now.toISOString()) ?? 0
      return { o, open, tgt: targetFor(o) }
    })
    .filter((x) => x.open > x.tgt)
    .sort((a, b) => b.open - b.tgt - (a.open - a.tgt))

  const sectionNames = [...new Set(input.orders.map((o) => o.section ?? 'general'))].sort()
  const sections = sectionNames.map((section) => {
    const rows = input.orders.filter((o) => (o.section ?? 'general') === section)
    const secTat = tats.filter((t) => t.section === section).map((t) => t.minutes).sort((a, b) => a - b)
    return {
      section,
      open: rows.filter(isOpen).length,
      overdue: overdueAll.filter((x) => (x.o.section ?? 'general') === section).length,
      releasedToday: rows.filter((o) => o.verified_at && dayKey(o.verified_at, offset) === todayKey).length,
      medianTatMinutes: percentile(secTat, 0.5),
    }
  })

  const rejected = input.orders.filter((o) => status(o) === 'REJECTED')
  const reasonCounts = new Map<string, number>()
  for (const r of rejected) {
    const reason = (r.rejection_reason ?? 'unspecified').replace(/_/g, ' ').toLowerCase()
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1)
  }

  const volume: LabDashboard['volume'] = []
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const key = dayKey(new Date(now.getTime() - i * 86_400_000).toISOString(), offset)
    volume.push({
      date: key,
      ordered: input.orders.filter((o) => o.ordered_at && dayKey(o.ordered_at, offset) === key).length,
      released: input.orders.filter((o) => o.verified_at && dayKey(o.verified_at, offset) === key).length,
    })
  }

  const testCounts = new Map<string, number>()
  for (const o of input.orders) {
    const t = o.test_name ?? 'Unknown test'
    testCounts.set(t, (testCounts.get(t) ?? 0) + 1)
  }

  const todayOrders = input.orders.filter((o) => o.ordered_at && dayKey(o.ordered_at, offset) === todayKey)

  return {
    generatedAt: now.toISOString(),
    windowDays,
    stages,
    sections,
    today: {
      ordered: todayOrders.length,
      released: input.orders.filter((o) => o.verified_at && dayKey(o.verified_at, offset) === todayKey).length,
      rejected: rejected.filter((o) => o.ordered_at && dayKey(o.ordered_at, offset) === todayKey).length,
      stat: todayOrders.filter((o) => o.urgency === 'STAT').length,
    },
    tat: {
      medianMinutes: percentile(sortedTat, 0.5),
      p90Minutes: percentile(sortedTat, 0.9),
      withinTargetPct: tats.length ? Math.round((tats.filter((t) => t.minutes <= t.target).length / tats.length) * 100) : null,
      sample: tats.length,
    },
    overdueTotal: overdueAll.length,
    overdue: overdueAll.slice(0, 25).map(({ o, open, tgt }) => ({
      id: o.id,
      accession: o.accession_number,
      test: o.test_name ?? 'Test',
      section: o.section ?? 'general',
      stage: status(o),
      urgency: o.urgency ?? 'ROUTINE',
      minutesOpen: Math.round(open),
      targetMinutes: tgt,
      patient: o.patient_name ?? null,
    })),
    rejections: { total: rejected.length, reasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) },
    volume,
    topTests: [...testCounts.entries()].map(([test, count]) => ({ test, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    criticalOpen: input.criticalOpen,
  }
}

// ---------------------------------------------------------------------------
// Cumulative results for one patient
// ---------------------------------------------------------------------------

export type CumulativeResultRow = {
  id: string
  lab_order_id: string | null
  loinc_code: string | null
  test_name: string | null
  result_value: string | null
  value: string | null
  numeric_value: number | string | null
  unit: string | null
  reference_range: string | null
  abnormal_flag: string | null
  is_critical: boolean | null
  status: string | null
  verified_at: string | null
  created_at: string | null
}

export type CumulativeSeries = {
  key: string
  test: string
  unit: string | null
  referenceRange: string | null
  points: { at: string; value: string; numeric: number | null; flag: string | null; critical: boolean; resultId: string }[]
  trend: 'rising' | 'falling' | 'steady' | 'single' | 'text'
}

const RELEASED = new Set(['VERIFIED', 'RELEASED', 'AMENDED', 'FINAL'])

/** Verified results grouped by test, oldest first, with direction for numbers. */
export function buildCumulativeResults(rows: CumulativeResultRow[]): CumulativeSeries[] {
  const groups = new Map<string, CumulativeSeries>()
  for (const r of rows) {
    if (!r.verified_at && !RELEASED.has(String(r.status ?? '').toUpperCase())) continue
    const at = r.verified_at ?? r.created_at
    if (!at) continue
    const key = (r.loinc_code || r.test_name || r.id).toLowerCase()
    const g = groups.get(key) ?? { key, test: r.test_name ?? 'Result', unit: r.unit, referenceRange: r.reference_range, points: [], trend: 'single' as const }
    const n = r.numeric_value == null || r.numeric_value === '' ? NaN : Number(r.numeric_value)
    g.points.push({
      at,
      value: String(r.result_value ?? r.value ?? r.numeric_value ?? ''),
      numeric: Number.isFinite(n) ? n : null,
      flag: r.abnormal_flag,
      critical: Boolean(r.is_critical),
      resultId: r.id,
    })
    if (r.reference_range) g.referenceRange = r.reference_range
    if (r.unit) g.unit = r.unit
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    g.points.sort((a, b) => a.at.localeCompare(b.at))
    const nums = g.points.map((p) => p.numeric).filter((x): x is number => x != null)
    if (nums.length !== g.points.length) g.trend = 'text'
    else if (nums.length < 2) g.trend = 'single'
    else {
      const first = nums[0]!
      const last = nums[nums.length - 1]!
      const change = (last - first) / Math.max(Math.abs(first), 1e-9)
      g.trend = change > 0.08 ? 'rising' : change < -0.08 ? 'falling' : 'steady'
    }
  }
  return [...groups.values()].sort((a, b) => (b.points.at(-1)?.at ?? '').localeCompare(a.points.at(-1)?.at ?? ''))
}
