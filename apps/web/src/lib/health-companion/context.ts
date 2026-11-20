/**
 * What the companion may see about the account holder. Each category is off
 * until the user consents to it, and every server read is filtered by the
 * session subject; nothing here accepts a user id from the request.
 */

export const CONSENT_CATEGORIES = ["medications", "appointments", "readings", "labs", "wearables"] as const
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number]
export type CompanionConsent = Record<ConsentCategory, boolean> & { acceptedTermsAt: string | null }

export const NO_CONSENT: CompanionConsent = {
  medications: false,
  appointments: false,
  readings: false,
  labs: false,
  wearables: false,
  acceptedTermsAt: null,
}

/** Short, human-readable lines per category. */
export type CompanionContext = Record<ConsentCategory, string[]>

export const EMPTY_CONTEXT: CompanionContext = {
  medications: [],
  appointments: [],
  readings: [],
  labs: [],
  wearables: [],
}

const MAX_ITEMS = 15
const MAX_LINE = 160

function cleanLine(value: unknown): string | null {
  if (typeof value !== "string") return null
  // Strip control characters and collapse whitespace; the line is data, not instructions.
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return line ? line.slice(0, MAX_LINE) : null
}

/**
 * Accepts a context snapshot the APK built from the user's own on-device store
 * (personal readings and medications live on the phone). Unknown keys and
 * non-string values are dropped, and lines are capped.
 */
export function sanitiseDeviceContext(input: unknown): CompanionContext {
  const out: CompanionContext = { ...EMPTY_CONTEXT }
  if (!input || typeof input !== "object") return out
  for (const category of CONSENT_CATEGORIES) {
    const raw = (input as Record<string, unknown>)[category]
    if (!Array.isArray(raw)) continue
    out[category] = raw.map(cleanLine).filter((l): l is string => Boolean(l)).slice(0, MAX_ITEMS)
  }
  return out
}

export function mergeContexts(...contexts: CompanionContext[]): CompanionContext {
  const out: CompanionContext = { ...EMPTY_CONTEXT }
  for (const category of CONSENT_CATEGORIES) {
    out[category] = [...new Set(contexts.flatMap((c) => c[category] ?? []))].slice(0, MAX_ITEMS)
  }
  return out
}

/** Drops every category the user has not consented to. */
export function applyConsent(context: CompanionContext, consent: CompanionConsent): CompanionContext {
  const out: CompanionContext = { ...EMPTY_CONTEXT }
  for (const category of CONSENT_CATEGORIES) {
    out[category] = consent[category] ? context[category] ?? [] : []
  }
  return out
}

const HEADINGS: Record<ConsentCategory, string> = {
  medications: "Medications on record",
  appointments: "Upcoming appointments",
  readings: "Recent readings (vitals)",
  labs: "Recent lab results",
  wearables: "Wearable data",
}

export function formatContext(context: CompanionContext): string {
  const blocks = CONSENT_CATEGORIES.filter((c) => context[c].length > 0).map(
    (c) => `${HEADINGS[c]}:\n${context[c].map((line) => `- ${line}`).join("\n")}`,
  )
  return blocks.join("\n\n")
}
