import { apiRequest } from './api'
import type { DailyReading, WearableMetric, WearableProvider } from './wearables-core'

/**
 * Owner-only endpoints. The server takes the owner from the session token, so
 * nothing here sends a user id: a staff account and a patient account call the
 * same routes and each only ever reaches its own readings.
 */

export type WearableConnection = {
  provider: WearableProvider
  scopes: WearableMetric[]
  consentVersion: string
  consentedAt: string
  lastSyncedAt: string | null
}

export type StoredDaily = DailyReading & { provider: WearableProvider; unit: string }

export type WearableSnapshot = {
  consentVersion: string
  connections: WearableConnection[]
  daily: StoredDaily[]
}

const PATH = '/api/mobile/health/wearables'

export function fetchWearables(token: string, days = 30): Promise<WearableSnapshot> {
  return apiRequest<WearableSnapshot>(`${PATH}?days=${days}`, { token, timeoutMs: 20_000 })
}

export function saveWearableConsent(token: string, provider: WearableProvider, scopes: WearableMetric[]) {
  return apiRequest<{ ok: boolean }>(PATH, {
    method: 'PUT',
    token,
    body: { provider, scopes, consent: true },
  })
}

export function uploadWearableReadings(token: string, provider: WearableProvider, readings: DailyReading[]) {
  return apiRequest<{ ok: boolean; saved: number; rejected: number }>(PATH, {
    method: 'POST',
    token,
    body: { provider, readings },
  })
}

export function disconnectWearable(token: string, provider: WearableProvider) {
  return apiRequest<{ ok: boolean }>(`${PATH}?provider=${provider}`, { method: 'DELETE', token })
}

export type SignupHealthFacts = { sex: string | null; gender: string | null; dateOfBirth: string | null }

export function fetchSignupHealthFacts(token: string) {
  return apiRequest<SignupHealthFacts>('/api/mobile/health/profile', { token, timeoutMs: 15_000 })
}
