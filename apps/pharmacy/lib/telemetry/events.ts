/**
 * Business events for Vercel Web Analytics.
 *
 * The platform's loader owns transport; this module owns the schema. Only the
 * events and properties named here can be sent, so a caller cannot pass a
 * customer name, a phone number, a receipt number or any free-form string:
 * every accepted value is a number, a boolean, or a member of a closed set.
 * With no loader present (local development, tests, or an environment where
 * insight collection is switched off) each call is a no-op, so nothing is
 * queued twice and nothing leaves a machine that was not meant to send.
 */

export type PaymentKind = "cash" | "mobile_money" | "card" | "insurance" | "credit" | "other"

export type TelemetryEvents = {
  /** A sale reached the ledger. Identifies the workflow, not the customer. */
  sale_completed: {
    items: number
    payment: PaymentKind
    credit: boolean
    offline: boolean
  }
  /** A sale attempt stopped before it reached the ledger. */
  sale_failed: { stage: "request" | "response" | "network"; status: number }
  /** A refund was recorded against an earlier sale. */
  refund_recorded: { items: number; reason: "customer_return" | "damaged" | "expired" | "other" }
  /** A Tally cut-over finished and the pharmacy is independent of Tally. */
  tally_cutover_completed: { chunks: number; documents: number }
  /** A Tally cut-over preflight or apply refused to proceed. */
  tally_cutover_blocked: { reason: string }
}

export type TelemetryEventName = keyof TelemetryEvents

const PAYMENTS: readonly PaymentKind[] = [
  "cash",
  "mobile_money",
  "card",
  "insurance",
  "credit",
  "other",
]

/** The POS screen stores payment methods in upper case. */
export function paymentKind(value: unknown): PaymentKind {
  return oneOf(
    typeof value === "string" ? value.toLowerCase() : value,
    PAYMENTS,
    "other",
  )
}

const REFUND_REASONS = ["customer_return", "damaged", "expired", "other"] as const

/** Why a cut-over stopped. A closed set, so no free-form text is sent. */
export type CutoverBlockReason =
  | "preflight"
  | "extraction"
  | "exceptions"
  | "reconciliation"
  | "audit"
  | "unknown"

const CUTOVER_REASONS: readonly CutoverBlockReason[] = [
  "preflight",
  "extraction",
  "exceptions",
  "reconciliation",
  "audit",
  "unknown",
]

/** Maps a refusal code to the closed set above. Unrecognised codes stay unknown. */
export function cutoverBlockReason(code: unknown): CutoverBlockReason {
  switch (code) {
    case "TALLY_PREFLIGHT_BLOCKED":
      return "preflight"
    case "TALLY_MANIFEST_MISSING":
    case "TALLY_MANIFEST_INVALID":
    case "TALLY_MANIFEST_INCOMPLETE":
    case "TALLY_SOURCE_TRUNCATED":
      return "extraction"
    case "TALLY_BLOCKING_EXCEPTIONS":
      return "exceptions"
    case "TALLY_AUDIT_FAILED":
    case "TALLY_FINALIZATION_FAILED":
      return "audit"
    default:
      return "unknown"
  }
}

type Loader = (...args: unknown[]) => void

declare global {
  interface Window {
    va?: Loader
    si?: Loader
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function flag(value: unknown): boolean {
  return value === true
}

/**
 * The payload for an event, built from its declared shape. Unknown properties
 * the caller passed are dropped here rather than at the transport.
 */
export function eventPayload<E extends TelemetryEventName>(
  name: E,
  props: TelemetryEvents[E],
): Record<string, string | number | boolean> {
  const value = (props ?? {}) as Record<string, unknown>
  switch (name) {
    case "sale_completed":
      return {
        items: count(value.items),
        payment: oneOf(value.payment, PAYMENTS, "other"),
        credit: flag(value.credit),
        offline: flag(value.offline),
      }
    case "sale_failed":
      return {
        stage: oneOf(value.stage, ["request", "response", "network"] as const, "network"),
        status: count(value.status),
      }
    case "refund_recorded":
      return {
        items: count(value.items),
        reason: oneOf(value.reason, REFUND_REASONS, "other"),
      }
    case "tally_cutover_completed":
      return { chunks: count(value.chunks), documents: count(value.documents) }
    case "tally_cutover_blocked":
      return { reason: oneOf(value.reason, CUTOVER_REASONS, "unknown") }
  }
}

/**
 * Sends one event through the loader the platform installed. A missing loader
 * is the normal case in development and is never an error.
 */
export function track<E extends TelemetryEventName>(
  name: E,
  props: TelemetryEvents[E],
  target: Window | undefined = typeof window === "undefined" ? undefined : window,
): void {
  if (!target || typeof target.va !== "function") return
  try {
    target.va("event", { name, data: eventPayload(name, props) })
  } catch {
    // Telemetry must never break a sale, a refund or a cut-over.
  }
}

/**
 * Replaces the credential an invitation or password-reset link carries in its
 * path. The inline bootstrap mirrors this pattern; keep the two in step.
 */
const TOKEN_PATH_RE = /^(\/invite(?:\/facility)?|\/reset-password)\/[^/]+/

/**
 * Drops query strings and fragments from the pageview URL before it leaves the
 * browser, and redacts the token in a path that carries one. Pharmacy screens
 * use opaque ids today, but a link shared with a filter can carry more.
 */
export function scrubPageview(event: Record<string, unknown>): Record<string, unknown> {
  if (typeof event.url !== "string") return event
  try {
    const url = new URL(event.url)
    url.search = ""
    url.hash = ""
    url.pathname = url.pathname.replace(TOKEN_PATH_RE, "$1/[token]")
    return { ...event, url: url.toString() }
  } catch {
    return { ...event, url: "" }
  }
}

/**
 * Registers the scrubber with both loaders. Called once when the portal mounts,
 * before the platform's script runs, so the first pageview is covered too.
 */
export function registerPrivacyHooks(target: Window | undefined = typeof window === "undefined" ? undefined : window): void {
  if (!target) return
  for (const loader of [target.va, target.si]) {
    if (typeof loader !== "function") continue
    try {
      loader("beforeSend", scrubPageview)
    } catch {
      // An older loader without beforeSend keeps working; it is not an error.
    }
  }
}
