/**
 * Wearable readings, independent of where they come from.
 *
 * Health Connect (Android) and HealthKit (iOS) both end up as one summary per
 * metric per local day. That is what the server stores and what the dashboard
 * draws. Pure: no React Native imports, so node:test covers it.
 */

export type WearableMetric =
  | 'steps'
  | 'heart_rate'
  | 'resting_heart_rate'
  | 'sleep_minutes'
  | 'active_calories'
  | 'distance_m'
  | 'weight_kg'
  | 'oxygen_saturation'

export type WearableProvider = 'health_connect' | 'healthkit'

export type DailyReading = {
  metric: WearableMetric
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  value: number
  min: number | null
  max: number | null
  samples: number
}

export type MetricDef = {
  metric: WearableMetric
  label: string
  unit: string
  /** Health Connect record type this metric is read from. */
  healthConnect: string
  /** Shown first and selected by default on the consent screen. */
  core: boolean
}

export const WEARABLE_METRICS: readonly MetricDef[] = [
  { metric: 'steps', label: 'Steps', unit: 'steps', healthConnect: 'Steps', core: true },
  { metric: 'heart_rate', label: 'Heart rate', unit: 'bpm', healthConnect: 'HeartRate', core: true },
  { metric: 'sleep_minutes', label: 'Sleep', unit: 'h', healthConnect: 'SleepSession', core: true },
  { metric: 'resting_heart_rate', label: 'Resting heart rate', unit: 'bpm', healthConnect: 'RestingHeartRate', core: false },
  { metric: 'active_calories', label: 'Active energy', unit: 'kcal', healthConnect: 'ActiveCaloriesBurned', core: false },
  { metric: 'distance_m', label: 'Distance', unit: 'km', healthConnect: 'Distance', core: false },
  { metric: 'weight_kg', label: 'Weight', unit: 'kg', healthConnect: 'Weight', core: false },
  { metric: 'oxygen_saturation', label: 'Blood oxygen', unit: '%', healthConnect: 'OxygenSaturation', core: false },
]

export function metricDef(metric: WearableMetric): MetricDef {
  return WEARABLE_METRICS.find((def) => def.metric === metric) ?? WEARABLE_METRICS[0]
}

export function localDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return localDay(new Date(y, m - 1, d + delta))
}

/** Permissions to request from Health Connect for the chosen metrics. Read-only. */
export function healthConnectPermissions(metrics: readonly WearableMetric[]) {
  return metrics.map((metric) => ({ accessType: 'read' as const, recordType: metricDef(metric).healthConnect }))
}

/** Which metrics are actually usable, given what the user granted in Health Connect. */
export function grantedMetrics(
  wanted: readonly WearableMetric[],
  granted: ReadonlyArray<{ accessType?: string; recordType?: string }>,
): WearableMetric[] {
  const readable = new Set(
    granted.filter((p) => p.accessType === 'read' && typeof p.recordType === 'string').map((p) => p.recordType),
  )
  return wanted.filter((metric) => readable.has(metricDef(metric).healthConnect))
}

/**
 * The window to read on a sync. Today's totals keep growing and watches upload
 * late, so the last two days are always re-read; the first sync goes back 30.
 */
export function sleepWindowStart(startTime: string): string {
  const start = new Date(startTime)
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 18).toISOString()
}

export function syncWindow(
  lastSyncedAt: string | null,
  now: Date = new Date(),
  maxDays = 30,
): { startTime: string; endTime: string } {
  const earliest = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (maxDays - 1)))
  let start = earliest
  const last = lastSyncedAt ? new Date(lastSyncedAt) : null
  if (last && !Number.isNaN(last.getTime())) {
    const overlap = startOfLocalDay(new Date(last.getFullYear(), last.getMonth(), last.getDate() - 1))
    if (overlap > earliest) start = overlap
  }
  return { startTime: start.toISOString(), endTime: now.toISOString() }
}

type AggregateGroup = { startTime: string; endTime?: string; result: Record<string, unknown> }

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function unitValue(value: unknown, key: string): number | null {
  if (value && typeof value === 'object') return num((value as Record<string, unknown>)[key])
  return null
}

/**
 * Health Connect daily aggregates → daily readings. Health Connect de-duplicates
 * overlapping sources (phone and watch both counting steps) inside aggregates,
 * which is why the app reads aggregates and not raw records.
 */
export function dailyFromHealthConnectAggregates(metric: WearableMetric, groups: readonly AggregateGroup[]): DailyReading[] {
  const out: DailyReading[] = []
  for (const group of groups) {
    const start = new Date(group.startTime)
    if (Number.isNaN(start.getTime())) continue
    // Sleep is read in 18:00→18:00 buckets and belongs to the morning you woke up.
    const end = group.endTime ? new Date(group.endTime) : null
    const day =
      metric === 'sleep_minutes' && end && !Number.isNaN(end.getTime())
        ? localDay(new Date(end.getTime() - 1))
        : localDay(start)
    const r = group.result ?? {}
    let value: number | null = null
    let min: number | null = null
    let max: number | null = null
    let samples = 1
    switch (metric) {
      case 'steps':
        value = num(r.COUNT_TOTAL)
        break
      case 'heart_rate':
      case 'resting_heart_rate':
        value = num(r.BPM_AVG)
        min = num(r.BPM_MIN)
        max = num(r.BPM_MAX)
        samples = num(r.MEASUREMENTS_COUNT) ?? 1
        break
      case 'sleep_minutes': {
        const seconds = num(r.SLEEP_DURATION_TOTAL)
        value = seconds === null ? null : Math.round(seconds / 60)
        break
      }
      case 'active_calories':
        value = unitValue(r.ACTIVE_CALORIES_TOTAL, 'inKilocalories')
        break
      case 'distance_m':
        value = unitValue(r.DISTANCE, 'inMeters')
        break
      case 'weight_kg':
        value = unitValue(r.WEIGHT_AVG, 'inKilograms')
        min = unitValue(r.WEIGHT_MIN, 'inKilograms')
        max = unitValue(r.WEIGHT_MAX, 'inKilograms')
        break
      case 'oxygen_saturation':
        value = null
        break
    }
    // An empty day aggregates to 0 (or nothing). Zero heart rate or weight is not
    // a reading, and zero steps on a day with no data would fake a flat line.
    if (value === null || value <= 0) continue
    out.push({ metric, day, value: Math.round(value * 10) / 10, min, max, samples: Math.max(1, Math.round(samples)) })
  }
  return out
}

/** Blood oxygen has no Health Connect aggregate, so records are averaged per day. */
export function dailyFromOxygenRecords(records: ReadonlyArray<{ time: string; percentage: unknown }>): DailyReading[] {
  const byDay = new Map<string, number[]>()
  for (const record of records) {
    const value = num(record.percentage)
    const time = new Date(record.time)
    if (value === null || value <= 0 || value > 100 || Number.isNaN(time.getTime())) continue
    const day = localDay(time)
    byDay.set(day, [...(byDay.get(day) ?? []), value])
  }
  return Array.from(byDay.entries()).map(([day, values]) => ({
    metric: 'oxygen_saturation' as const,
    day,
    value: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values.length,
  }))
}

/** One value per day for the last `days` days ending today, null where nothing was recorded. */
export function seriesFor(
  readings: ReadonlyArray<Pick<DailyReading, 'metric' | 'day' | 'value'>>,
  metric: WearableMetric,
  days: number,
  today: string,
): Array<{ day: string; value: number | null }> {
  const byDay = new Map(readings.filter((r) => r.metric === metric).map((r) => [r.day, r.value]))
  return Array.from({ length: days }, (_, index) => {
    const day = addDays(today, index - (days - 1))
    return { day, value: byDay.get(day) ?? null }
  })
}

export type Trend = {
  average: number | null
  previousAverage: number | null
  /** Percent change week on week, rounded; null when either week is empty. */
  changePct: number | null
  direction: 'up' | 'down' | 'flat' | 'none'
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null
}

/** This week's daily average against the week before. */
export function weeklyTrend(
  readings: ReadonlyArray<Pick<DailyReading, 'metric' | 'day' | 'value'>>,
  metric: WearableMetric,
  today: string,
): Trend {
  const fortnight = seriesFor(readings, metric, 14, today).map((point) => point.value)
  const previousAverage = mean(fortnight.slice(0, 7))
  const average = mean(fortnight.slice(7))
  if (average === null) return { average, previousAverage, changePct: null, direction: 'none' }
  if (previousAverage === null || previousAverage === 0) {
    return { average, previousAverage, changePct: null, direction: 'none' }
  }
  const changePct = Math.round(((average - previousAverage) / previousAverage) * 100)
  return {
    average,
    previousAverage,
    changePct,
    direction: Math.abs(changePct) < 5 ? 'flat' : changePct > 0 ? 'up' : 'down',
  }
}

/** Display a value in the metric's unit: sleep as hours, distance as km. */
export function formatMetric(metric: WearableMetric, value: number | null): string {
  if (value === null) return '—'
  switch (metric) {
    case 'sleep_minutes': {
      const h = Math.floor(value / 60)
      const m = Math.round(value % 60)
      return m ? `${h}h ${m}m` : `${h}h`
    }
    case 'distance_m':
      return (value / 1000).toFixed(1)
    case 'steps':
    case 'active_calories':
      return Math.round(value).toLocaleString('en-US')
    default:
      return String(Math.round(value * 10) / 10)
  }
}
