/**
 * The setup assistant's side of the prerequisite report.
 *
 * The bridge runs the checks on the pharmacy computer; this module asks for
 * them, refuses a report it cannot understand, and adds the one check only the
 * portal can make — whether the connector's contract is new enough for this
 * page. Nothing here reads company data or writes anything.
 */

import { BRIDGE_BASE_URL, TallyBridgeError } from "./bridge-client"

/** The lowest connector contract this page can drive. */
export const MIN_BRIDGE_CONTRACT = 2

export type PrerequisiteStatus =
  | "passed"
  | "warning"
  | "missing"
  | "failed"
  | "blocked"
  | "not_applicable"

export type PrerequisiteCheck = {
  id: string
  name: string
  status: PrerequisiteStatus
  required: boolean
  detectedVersion: string | null
  requiredVersion: string | null
  message: string
  remediation: string | null
  canAutoFix: boolean
  requiresAdministrator: boolean
  evidence: Record<string, unknown> | null
  lastCheckedAt: string
}

export type PrerequisiteSummary = {
  total: number
  passed: number
  warning: number
  missing: number
  failed: number
  blocked: number
  not_applicable: number
  blocking: string[]
  autoFixable: string[]
  ready: boolean
}

export type PrerequisiteReport = {
  checkedAt: string
  connector: {
    version: string | null
    contractVersion: number | null
    bindHost: string | null
    port: number | null
  }
  target: string | null
  company: string | null
  checks: PrerequisiteCheck[]
  summary: PrerequisiteSummary
}

const STATUSES: PrerequisiteStatus[] = [
  "passed",
  "warning",
  "missing",
  "failed",
  "blocked",
  "not_applicable",
]
const BLOCKING = new Set<PrerequisiteStatus>(["missing", "failed", "blocked"])

const MESSAGES: Record<string, string> = {
  TALLY_BRIDGE_HTTP_404:
    "This Tally Bridge does not offer a setup check, so it is older than this page. Run the installer from this page to update it, then check again.",
  TALLY_BRIDGE_HTTP_401: "The bridge is running, but it did not accept this token.",
  TALLY_BRIDGE_HTTP_403:
    "The bridge is running, but it does not allow this page's origin. Start it with the command this page generated.",
  TALLY_BRIDGE_HTTP_409: "A Tally export is already running on this connector. Wait for it to finish, then check again.",
}

function messageFor(code: string, status: number): string {
  return MESSAGES[code] ?? MESSAGES[`TALLY_BRIDGE_HTTP_${status}`] ?? `The Tally Bridge returned HTTP ${status}.`
}

async function bridgeError(response: Response): Promise<TallyBridgeError> {
  let code = ""
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === "string") code = body.error
  } catch {
    // A non-JSON answer keeps the explicit status in the message below.
  }
  return new TallyBridgeError(code || `TALLY_BRIDGE_HTTP_${response.status}`, messageFor(code, response.status), response.status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseCheck(value: unknown): PrerequisiteCheck | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string" || typeof value.name !== "string") return null
  if (typeof value.status !== "string" || !STATUSES.includes(value.status as PrerequisiteStatus)) return null
  if (typeof value.required !== "boolean") return null
  return {
    id: value.id,
    name: value.name,
    status: value.status as PrerequisiteStatus,
    required: value.required,
    detectedVersion: typeof value.detectedVersion === "string" ? value.detectedVersion : null,
    requiredVersion: typeof value.requiredVersion === "string" ? value.requiredVersion : null,
    message: typeof value.message === "string" ? value.message : "",
    remediation: typeof value.remediation === "string" ? value.remediation : null,
    canAutoFix: value.canAutoFix === true,
    requiresAdministrator: value.requiresAdministrator === true,
    evidence: isRecord(value.evidence) ? value.evidence : null,
    lastCheckedAt: typeof value.lastCheckedAt === "string" ? value.lastCheckedAt : "",
  }
}

/**
 * Refuses an answer that is not a complete report. A connector that speaks a
 * different shape is treated as unusable rather than half-rendered, because a
 * missing check would read as a pass.
 */
export function parsePrerequisiteReport(value: unknown): PrerequisiteReport | null {
  if (!isRecord(value) || !isRecord(value.connector)) return null
  if (!Array.isArray(value.checks)) return null
  const checks = value.checks.map(parseCheck)
  if (checks.some((check) => check === null)) return null
  const connector = value.connector
  return {
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    connector: {
      version: typeof connector.version === "string" ? connector.version : null,
      contractVersion: typeof connector.contractVersion === "number" ? connector.contractVersion : null,
      bindHost: typeof connector.bindHost === "string" ? connector.bindHost : null,
      port: typeof connector.port === "number" ? connector.port : null,
    },
    target: typeof value.target === "string" ? value.target : null,
    company: typeof value.company === "string" ? value.company : null,
    checks: checks as PrerequisiteCheck[],
    summary: summariseChecks(checks as PrerequisiteCheck[]),
  }
}

export function summariseChecks(checks: PrerequisiteCheck[]): PrerequisiteSummary {
  const counts = {
    total: checks.length,
    passed: 0,
    warning: 0,
    missing: 0,
    failed: 0,
    blocked: 0,
    not_applicable: 0,
  }
  for (const check of checks) counts[check.status] += 1
  const blocking = checks
    .filter((check) => check.required && BLOCKING.has(check.status))
    .map((check) => check.id)
  return {
    ...counts,
    blocking,
    autoFixable: checks
      .filter((check) => check.canAutoFix && BLOCKING.has(check.status))
      .map((check) => check.id),
    ready: blocking.length === 0,
  }
}

/**
 * The connector's contract is compared with this page's minimum. An older
 * connector may export on a period protocol this page no longer sends, so it
 * is blocked rather than guessed at.
 */
export function compatibilityCheck(
  connector: PrerequisiteReport["connector"],
  minimum = MIN_BRIDGE_CONTRACT,
  checkedAt = new Date().toISOString(),
): PrerequisiteCheck {
  const contract = connector.contractVersion
  const stale = contract === null || contract < minimum
  return {
    id: "portal_compatibility",
    name: "Connector matches this page",
    status: stale ? "failed" : "passed",
    required: true,
    detectedVersion: contract === null ? null : String(contract),
    requiredVersion: String(minimum),
    message:
      contract === null
        ? "The connector did not report which contract it implements, so this page cannot confirm it understands it."
        : stale
          ? `The connector implements contract ${contract}; this page needs ${minimum} or later.`
          : `The connector implements contract ${contract}, which this page understands.`,
    remediation: stale ? "Run the connector installer from this page to update it, then check again." : null,
    canAutoFix: stale,
    requiresAdministrator: false,
    evidence: {
      connectorVersion: connector.version,
      contractVersion: contract,
      portalMinimum: minimum,
    },
    lastCheckedAt: checkedAt,
  }
}

/** Returns the report with the portal's own compatibility check appended. */
export function withCompatibility(
  report: PrerequisiteReport,
  minimum = MIN_BRIDGE_CONTRACT,
): PrerequisiteReport {
  const checks = [...report.checks, compatibilityCheck(report.connector, minimum, report.checkedAt)]
  return { ...report, checks, summary: summariseChecks(checks) }
}

export async function requestBridgePreflight(input: {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  minimumContract?: number
}): Promise<PrerequisiteReport> {
  if (!input.token.trim()) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_TOKEN_REQUIRED",
      "Enter the bridge token before checking this computer.",
    )
  }
  const fetchImpl = input.fetchImpl ?? fetch
  const base = (input.baseUrl ?? BRIDGE_BASE_URL).replace(/\/+$/, "")
  const response = await fetchImpl(`${base}/api/tally/preflight`, {
    headers: { "x-synapse-tally-bridge-token": input.token.trim() },
    cache: "no-store",
  })
  if (!response.ok) throw await bridgeError(response)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_PREFLIGHT_INVALID",
      "The bridge answered the setup check with something that was not a report. Update the connector and try again.",
    )
  }
  const report = parsePrerequisiteReport(body)
  if (!report) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_PREFLIGHT_INVALID",
      "The bridge's setup report was incomplete, so it was not used. Update the connector and try again.",
    )
  }
  return withCompatibility(report, input.minimumContract ?? MIN_BRIDGE_CONTRACT)
}

/** Every required check that stands between this computer and a bridge. */
export function blockingChecks(report: PrerequisiteReport): PrerequisiteCheck[] {
  return report.checks.filter((check) => check.required && BLOCKING.has(check.status))
}

/** Checks that can be repaired by running the installer, in report order. */
export function installableChecks(report: PrerequisiteReport): PrerequisiteCheck[] {
  return report.checks.filter((check) => check.canAutoFix && BLOCKING.has(check.status))
}

/** Checks the operator has to act on by hand. */
export function manualChecks(report: PrerequisiteReport): PrerequisiteCheck[] {
  return report.checks.filter(
    (check) => check.required && BLOCKING.has(check.status) && !check.canAutoFix,
  )
}
