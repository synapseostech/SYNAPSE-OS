import { NativeModules, Platform, TurboModuleRegistry } from 'react-native'
import {
  dailyFromHealthConnectAggregates,
  dailyFromOxygenRecords,
  grantedMetrics,
  healthConnectPermissions,
  sleepWindowStart,
  syncWindow,
  type DailyReading,
  type WearableMetric,
  type WearableProvider,
} from './wearables-core'

/**
 * One interface for every phone health store. Health Connect is the Android
 * implementation and covers Samsung Health, Fitbit, Xiaomi / Mi Fitness, Garmin
 * Connect, Oura, Withings and most other watch and band apps, as long as that
 * app has "sync to Health Connect" switched on. HealthKit is declared so the
 * iOS build has a place to plug in, but this release does not ship an iOS
 * binary, so it reports itself unavailable instead of pretending.
 */
export type SourceStatus =
  | { state: 'available' }
  | { state: 'needs_install'; message: string }
  | { state: 'needs_app_update'; message: string }
  | { state: 'unsupported'; message: string }

export interface WearableSource {
  provider: WearableProvider
  label: string
  /** Store names shown to the user so they know their watch is covered. */
  covers: string
  status(): Promise<SourceStatus>
  /** Opens the system permission sheet. Returns the metrics actually granted. */
  requestAccess(metrics: readonly WearableMetric[]): Promise<WearableMetric[]>
  grantedMetrics(metrics: readonly WearableMetric[]): Promise<WearableMetric[]>
  readDaily(metrics: readonly WearableMetric[], lastSyncedAt: string | null): Promise<DailyReading[]>
  /** Where the user revokes access at the OS level. */
  openSettings(): void
}

type HealthConnectApi = typeof import('react-native-health-connect')

/**
 * The native module only exists in APKs built with this release. An older APK
 * that receives this JavaScript over the air must not crash on import, so the
 * module is looked up before the library is loaded.
 */
function loadHealthConnect(): HealthConnectApi | null {
  if (Platform.OS !== 'android') return null
  let native: unknown = null
  try {
    native = TurboModuleRegistry.get('HealthConnect') ?? NativeModules.HealthConnect ?? null
  } catch {
    native = null
  }
  if (!native) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-health-connect') as HealthConnectApi
  } catch {
    return null
  }
}

let initialised = false

async function ready(hc: HealthConnectApi): Promise<boolean> {
  if (initialised) return true
  initialised = await hc.initialize()
  return initialised
}

const healthConnect: WearableSource = {
  provider: 'health_connect',
  label: 'Health Connect',
  covers: 'Samsung Health, Fitbit, Xiaomi, Garmin and most Android watches and bands',

  async status() {
    const hc = loadHealthConnect()
    if (Platform.OS !== 'android') {
      return { state: 'unsupported', message: 'Health Connect is only on Android.' }
    }
    if (!hc) {
      return {
        state: 'needs_app_update',
        message: 'Install the latest Synapse app from your facility or the download page to connect a watch.',
      }
    }
    const sdk = await hc.getSdkStatus().catch(() => hc.SdkAvailabilityStatus.SDK_UNAVAILABLE)
    if (sdk === hc.SdkAvailabilityStatus.SDK_AVAILABLE) return { state: 'available' }
    if (sdk === hc.SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
      return { state: 'needs_install', message: 'Update Health Connect from the Play Store, then try again.' }
    }
    return {
      state: 'needs_install',
      message: 'Install Health Connect from the Play Store (Android 13 and older), then try again.',
    }
  },

  async requestAccess(metrics) {
    const hc = loadHealthConnect()
    if (!hc || !(await ready(hc))) return []
    const granted = await hc.requestPermission(healthConnectPermissions(metrics) as never)
    return grantedMetrics(metrics, granted as Array<{ accessType?: string; recordType?: string }>)
  },

  async grantedMetrics(metrics) {
    const hc = loadHealthConnect()
    if (!hc || !(await ready(hc))) return []
    const granted = await hc.getGrantedPermissions().catch(() => [])
    return grantedMetrics(metrics, granted as Array<{ accessType?: string; recordType?: string }>)
  },

  async readDaily(metrics, lastSyncedAt) {
    const hc = loadHealthConnect()
    if (!hc || !(await ready(hc))) return []
    const window = syncWindow(lastSyncedAt)
    const out: DailyReading[] = []
    for (const metric of metrics) {
      try {
        if (metric === 'oxygen_saturation') {
          const { records } = await hc.readRecords('OxygenSaturation', {
            timeRangeFilter: { operator: 'between', ...window },
          })
          out.push(...dailyFromOxygenRecords(records as Array<{ time: string; percentage: unknown }>))
          continue
        }
        const recordType = {
          steps: 'Steps',
          heart_rate: 'HeartRate',
          resting_heart_rate: 'RestingHeartRate',
          sleep_minutes: 'SleepSession',
          active_calories: 'ActiveCaloriesBurned',
          distance_m: 'Distance',
          weight_kg: 'Weight',
        }[metric] as 'Steps'
        const startTime = metric === 'sleep_minutes' ? sleepWindowStart(window.startTime) : window.startTime
        const groups = await hc.aggregateGroupByPeriod({
          recordType,
          timeRangeFilter: { operator: 'between', startTime, endTime: window.endTime },
          timeRangeSlicer: { period: 'DAYS', length: 1 },
        })
        out.push(
          ...dailyFromHealthConnectAggregates(
            metric,
            groups as unknown as Array<{ startTime: string; endTime?: string; result: Record<string, unknown> }>,
          ),
        )
      } catch {
        // One metric the user did not grant, or a source with no data, must not
        // stop the rest of the sync.
      }
    }
    return out
  },

  openSettings() {
    loadHealthConnect()?.openHealthConnectSettings()
  },
}

const healthKit: WearableSource = {
  provider: 'healthkit',
  label: 'Apple Health',
  covers: 'Apple Watch and apps that write to Apple Health',
  async status() {
    return {
      state: 'unsupported',
      message: 'Apple Health arrives with the iPhone app. Your readings from Android are kept meanwhile.',
    }
  },
  async requestAccess() {
    return []
  },
  async grantedMetrics() {
    return []
  },
  async readDaily() {
    return []
  },
  openSettings() {},
}

/** The source for this phone. */
export function deviceWearableSource(): WearableSource {
  return Platform.OS === 'ios' ? healthKit : healthConnect
}
