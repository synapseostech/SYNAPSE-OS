import { apiRequest, ApiError } from '@/lib/api'
import { listMedications, listVitals, type VitalsReading } from '@/lib/personal-store'

/**
 * Client for the My Health AI companion. Every call goes to the web server
 * route (/api/health/companion); the provider key never exists in the APK.
 */

export type CompanionLanguage = 'en' | 'lg' | 'sw'
export type SafetyKind = 'none' | 'emergency' | 'dose_refusal' | 'output_blocked' | 'provider_unavailable'
export type ConsentCategory = 'medications' | 'appointments' | 'readings' | 'labs' | 'wearables'
export type CompanionConsent = Record<ConsentCategory, boolean> & { acceptedTermsAt: string | null }
export type CompanionMessage = { id: string; role: 'user' | 'assistant'; content: string; safetyKind: SafetyKind }
export type CompanionConversation = { id: string; title: string; updatedAt: string }
export type CompanionState = {
  consent: CompanionConsent
  conversations: CompanionConversation[]
  messages: CompanionMessage[]
  quota: { limit: number; used: number; remaining: number }
  providerConfigured: boolean
  emergencyNumbers: Array<{ number: string; label: string }>
}

export const CONSENT_LABELS: Array<{ key: ConsentCategory; label: string; hint: string }> = [
  { key: 'medications', label: 'Medicines', hint: 'Your medicine list on this phone and at your clinic' },
  { key: 'appointments', label: 'Appointments', hint: 'Upcoming visits and teleconsults' },
  { key: 'readings', label: 'Readings', hint: 'Blood pressure, glucose, weight you logged' },
  { key: 'labs', label: 'Lab results', hint: 'Results your facility released to you' },
  { key: 'wearables', label: 'Wearables', hint: 'Steps and readings from connected devices' },
]

export const NOT_A_DOCTOR =
  'Synapse Companion is an AI, not a doctor. It does not diagnose, prescribe or change doses. In an emergency call 112 or 999.'

export async function getCompanionState(token: string, conversationId?: string | null): Promise<CompanionState> {
  const q = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''
  return apiRequest<CompanionState>(`/api/health/companion${q}`, { token })
}

export async function saveCompanionConsent(token: string, consent: Record<ConsentCategory, boolean>): Promise<void> {
  await apiRequest('/api/health/companion/consent', { method: 'PUT', token, body: { acceptTerms: true, ...consent } })
}

export async function deleteCompanionConversation(token: string, conversationId: string | 'all'): Promise<void> {
  const q = conversationId === 'all' ? '?all=1' : `?conversationId=${encodeURIComponent(conversationId)}`
  await apiRequest(`/api/health/companion${q}`, { method: 'DELETE', token })
}

function vitalLine(v: VitalsReading): string {
  const day = v.recordedAt.slice(0, 10)
  if (v.kind === 'blood_pressure' && v.systolic && v.diastolic) return `${day} blood pressure ${v.systolic}/${v.diastolic} ${v.unit}`
  return `${day} ${v.kind.replace(/_/g, ' ')} ${v.value ?? ''} ${v.unit}`.trim()
}

/**
 * Personal readings and medicines live on this phone. Only the categories the
 * person consented to leave the device; the server applies consent again.
 */
export async function buildDeviceContext(userId: string, consent: CompanionConsent) {
  const context: Partial<Record<ConsentCategory, string[]>> = {}
  if (consent.medications) {
    const meds = await listMedications(userId).catch(() => [])
    context.medications = meds.map((m) => [m.name, m.dose, m.schedule].filter(Boolean).join(' ')).slice(0, 15)
  }
  if (consent.readings) {
    const vitals = await listVitals(userId, undefined, 10).catch(() => [])
    context.readings = vitals.map(vitalLine)
  }
  return context
}

export type SendResult = {
  reply: string
  safetyKind: SafetyKind
  conversationId: string | null
}

export async function sendCompanionMessage(
  token: string,
  input: { message: string; conversationId: string | null; language: CompanionLanguage; deviceContext: unknown },
): Promise<SendResult> {
  try {
    const res = await apiRequest<{ reply: string; safetyKind: SafetyKind; conversationId: string }>('/api/health/companion', {
      method: 'POST',
      token,
      body: input,
      timeoutMs: 35_000,
    })
    return res
  } catch (err) {
    const fallback = (reply: string): SendResult => ({ reply, safetyKind: 'provider_unavailable', conversationId: input.conversationId })
    if (err instanceof ApiError) {
      if (err.status === 412) return fallback('Please accept the terms first. If this is urgent, call 112 or 999 or go to the nearest health facility.')
      if (err.status === 429 && err.payload.error === 'daily_limit_reached') {
        return fallback("You've used today's companion messages. They reset tomorrow. In an emergency call 112 or 999.")
      }
      if (err.status === 429) return fallback('Please wait a minute before sending another message.')
    }
    return fallback('Sorry, I could not respond right now. Check your connection and try again. In an emergency call 112 or 999.')
  }
}
