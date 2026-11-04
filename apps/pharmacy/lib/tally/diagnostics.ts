/**
 * Reporting a bridge failure to the portal server.
 *
 * The bridge runs on the operator's own machine, so a failure there reaches the
 * server only if the page says so. Everything below is best-effort: it never
 * throws, never blocks, and never changes what the operator sees. Losing a
 * report is acceptable; losing a cut-over because reporting failed is not.
 */

export type TallyDiagnosticStep =
  | "bridge-check"
  | "bridge-companies"
  | "closing-export"
  | "extraction"
  | "extraction-resume"
  | "apply"

export type TallyDiagnosticOutcome =
  | "failed"
  | "attempts_exhausted"
  | "cancelled"
  | "network"
  | "http"

export type TallyDiagnosticReport = {
  step: TallyDiagnosticStep
  outcome?: TallyDiagnosticOutcome
  code?: string
  status?: number
  sessionId?: string
}

const ENDPOINT = "/api/admin/tally/diagnostics"
const CODE_PATTERN = /^TALLY_[A-Z0-9_]{1,64}$/

/** The code and status an error carries, when they are the shape the route accepts. */
export function diagnosticFrom(error: unknown): { code?: string; status?: number } {
  if (typeof error !== "object" || error === null) return {}
  const record = error as { code?: unknown; status?: unknown }
  const code =
    typeof record.code === "string" && CODE_PATTERN.test(record.code) ? record.code : undefined
  const status =
    typeof record.status === "number" &&
    Number.isInteger(record.status) &&
    record.status >= 100 &&
    record.status <= 599
      ? record.status
      : undefined
  return { ...(code ? { code } : {}), ...(status ? { status } : {}) }
}

export function reportTallyFailure(report: TallyDiagnosticReport): void {
  if (typeof window === "undefined") return

  const body: TallyDiagnosticReport = { step: report.step }
  if (report.outcome) body.outcome = report.outcome
  if (report.code && CODE_PATTERN.test(report.code)) body.code = report.code
  if (report.status) body.status = report.status
  if (report.sessionId) body.sessionId = report.sessionId

  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Reporting must never break the flow it is reporting on.
  }
}
