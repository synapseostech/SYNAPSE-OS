/**
 * Server side of My Synapse Health wearables.
 *
 * Every function takes the owner id from the caller, which must be the verified
 * session subject (see ./owner.ts), and every query filters on it. Nothing here
 * reads or writes by tenant.
 */

export const WEARABLE_PROVIDERS = ['health_connect', 'healthkit'] as const
export type WearableProvider = (typeof WEARABLE_PROVIDERS)[number]

/** Bumped when the consent text in the app changes, so old consents are visible. */
export const WEARABLE_CONSENT_VERSION = '2026-11-v1'

/** Metric → unit and a plausible daily range. Values outside the range are dropped. */
export const WEARABLE_METRICS = {
  steps: { unit: 'count', max: 200_000 },
  heart_rate: { unit: 'bpm', max: 260 },
  resting_heart_rate: { unit: 'bpm', max: 200 },
  sleep_minutes: { unit: 'min', max: 24 * 60 },
  active_calories: { unit: 'kcal', max: 20_000 },
  distance_m: { unit: 'm', max: 500_000 },
  weight_kg: { unit: 'kg', max: 500 },
  oxygen_saturation: { unit: '%', max: 100 },
} as const
export type WearableMetric = keyof typeof WEARABLE_METRICS

export const MAX_READINGS_PER_UPLOAD = 1000
export const MAX_HISTORY_DAYS = 90

export type DailyReading = {
  metric: WearableMetric
  day: string
  value: number
  min: number | null
  max: number | null
  samples: number
}

export function isProvider(value: unknown): value is WearableProvider {
  return typeof value === 'string' && (WEARABLE_PROVIDERS as readonly string[]).includes(value)
}

export function isMetric(value: unknown): value is WearableMetric {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEARABLE_METRICS, value)
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseScopes(value: unknown): WearableMetric[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter(isMetric)))
}

/**
 * Accepts the app's upload and returns only well-formed, in-range readings for
 * metrics the user consented to. Owner fields in the body are never read.
 */
export function parseReadings(
  value: unknown,
  scopes: readonly string[],
  now: Date = new Date(),
): { readings: DailyReading[]; rejected: number } {
  if (!Array.isArray(value)) return { readings: [], rejected: 0 }
  const allowed = new Set(scopes)
  const newest = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const oldest = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const byKey = new Map<string, DailyReading>()
  let rejected = 0
  for (const item of value.slice(0, MAX_READINGS_PER_UPLOAD)) {
    const raw = (item ?? {}) as Record<string, unknown>
    const metric = raw.metric
    const day = raw.day
    const amount = finite(raw.value)
    if (!isMetric(metric) || !allowed.has(metric) || !isDay(day) || amount === null) {
      rejected += 1
      continue
    }
    if (day > newest || day < oldest || amount < 0 || amount > WEARABLE_METRICS[metric].max) {
      rejected += 1
      continue
    }
    const min = finite(raw.min)
    const max = finite(raw.max)
    const samples = finite(raw.samples)
    byKey.set(`${metric}:${day}`, {
      metric,
      day,
      value: amount,
      min: min !== null && min >= 0 ? min : null,
      max: max !== null && max >= 0 ? max : null,
      samples: samples !== null && samples >= 0 ? Math.round(samples) : 1,
    })
  }
  rejected += Math.max(0, value.length - MAX_READINGS_PER_UPLOAD)
  return { readings: Array.from(byKey.values()), rejected }
}

export function historyStart(days: number, now: Date = new Date()): string {
  const span = Math.min(Math.max(Math.round(days) || 30, 1), MAX_HISTORY_DAYS)
  return new Date(now.getTime() - (span - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export type WearableConnection = {
  provider: WearableProvider
  scopes: WearableMetric[]
  consentVersion: string
  consentedAt: string
  lastSyncedAt: string | null
}

export async function listConnections(db: Db, ownerId: string): Promise<WearableConnection[]> {
  const { data, error } = await db
    .from('personal_wearable_connections')
    .select('provider, scopes, consent_version, consented_at, last_synced_at')
    .eq('owner_profile_id', ownerId)
  if (error) throw new Error('connections_read_failed')
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    provider: row.provider as WearableProvider,
    scopes: parseScopes(row.scopes),
    consentVersion: String(row.consent_version ?? ''),
    consentedAt: String(row.consented_at ?? ''),
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
  }))
}

export async function listDaily(
  db: Db,
  ownerId: string,
  fromDay: string,
): Promise<Array<DailyReading & { provider: WearableProvider; unit: string }>> {
  const { data, error } = await db
    .from('personal_wearable_daily')
    .select('provider, metric, day, value, min_value, max_value, sample_count, unit')
    .eq('owner_profile_id', ownerId)
    .gte('day', fromDay)
    .order('day', { ascending: true })
  if (error) throw new Error('daily_read_failed')
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    provider: row.provider as WearableProvider,
    metric: row.metric as WearableMetric,
    day: String(row.day),
    value: Number(row.value),
    min: row.min_value == null ? null : Number(row.min_value),
    max: row.max_value == null ? null : Number(row.max_value),
    samples: Number(row.sample_count ?? 1),
    unit: String(row.unit ?? ''),
  }))
}

export async function recordConsent(
  db: Db,
  ownerId: string,
  provider: WearableProvider,
  scopes: WearableMetric[],
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await db.from('personal_wearable_connections').upsert(
    {
      owner_profile_id: ownerId,
      provider,
      scopes,
      consent_version: WEARABLE_CONSENT_VERSION,
      consented_at: now,
      updated_at: now,
    },
    { onConflict: 'owner_profile_id,provider' },
  )
  if (error) throw new Error('consent_write_failed')
}

export async function saveReadings(
  db: Db,
  ownerId: string,
  provider: WearableProvider,
  readings: DailyReading[],
): Promise<void> {
  const now = new Date().toISOString()
  if (readings.length) {
    const rows = readings.map((reading) => ({
      owner_profile_id: ownerId,
      provider,
      metric: reading.metric,
      day: reading.day,
      value: reading.value,
      min_value: reading.min,
      max_value: reading.max,
      sample_count: reading.samples,
      unit: WEARABLE_METRICS[reading.metric].unit,
      updated_at: now,
    }))
    const { error } = await db
      .from('personal_wearable_daily')
      .upsert(rows, { onConflict: 'owner_profile_id,provider,metric,day' })
    if (error) throw new Error('readings_write_failed')
  }
  const { error: syncError } = await db
    .from('personal_wearable_connections')
    .update({ last_synced_at: now, updated_at: now })
    .eq('owner_profile_id', ownerId)
    .eq('provider', provider)
  if (syncError) throw new Error('sync_stamp_failed')
}

/**
 * Withdraws consent and deletes the provider's readings. The table's foreign key
 * cascades, and the readings delete is issued anyway so the outcome does not
 * depend on the cascade alone.
 */
export async function disconnect(db: Db, ownerId: string, provider: WearableProvider): Promise<void> {
  const { error: readingsError } = await db
    .from('personal_wearable_daily')
    .delete()
    .eq('owner_profile_id', ownerId)
    .eq('provider', provider)
  if (readingsError) throw new Error('readings_delete_failed')
  const { error } = await db
    .from('personal_wearable_connections')
    .delete()
    .eq('owner_profile_id', ownerId)
    .eq('provider', provider)
  if (error) throw new Error('connection_delete_failed')
}
