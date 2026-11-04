import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission } from "@/lib/tally/auth"
import { consumeRateLimits } from "@/lib/distributed-rate-limit"
import { logTallyFailure } from "@/lib/tally/http"

/**
 * POST /api/admin/tally/diagnostics
 *
 * The portal reads Tally through a bridge on the operator's own machine, so a
 * bridge failure never reaches this server on its own. The page reports the
 * failure here so it exists as a log line instead of only as a toast.
 *
 * The body is a closed schema: no free text, no company name, no voucher
 * content, no token. A compromised page cannot turn this route into a channel
 * for the books it is importing.
 */

const STEPS = new Set([
  "bridge-check",
  "bridge-companies",
  "closing-export",
  "extraction",
  "extraction-resume",
  "apply",
])

const OUTCOMES = new Set(["failed", "attempts_exhausted", "cancelled", "network", "http"])

const ALLOWED_KEYS = new Set(["step", "outcome", "code", "status", "sessionId"])
const CODE_PATTERN = /^TALLY_[A-Z0-9_]{1,64}$/
const SESSION_PATTERN = /^[A-Za-z0-9-]{1,64}$/

const MAX_BODY_CHARS = 4 * 1024

type Report = {
  step: string
  outcome?: string
  code?: string
  status?: number
  sessionId?: string
}

function invalid(error: string) {
  return NextResponse.json({ error, code: "TALLY_DIAGNOSTIC_INVALID" }, { status: 400 })
}

function readReport(body: unknown): Report | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The report must be a JSON object."
  }
  const record = body as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return `Unknown field: ${key}.`
  }
  if (typeof record.step !== "string" || !STEPS.has(record.step)) {
    return "step must name one of the portal's failure points."
  }
  const report: Report = { step: record.step }

  if (record.outcome !== undefined) {
    if (typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome)) {
      return "outcome is not a recognised value."
    }
    report.outcome = record.outcome
  }
  if (record.code !== undefined) {
    if (typeof record.code !== "string" || !CODE_PATTERN.test(record.code)) {
      return "code must look like a Tally refusal code."
    }
    report.code = record.code
  }
  if (record.status !== undefined) {
    if (
      typeof record.status !== "number" ||
      !Number.isInteger(record.status) ||
      record.status < 100 ||
      record.status > 599
    ) {
      return "status must be an HTTP status code."
    }
    report.status = record.status
  }
  if (record.sessionId !== undefined) {
    if (typeof record.sessionId !== "string" || !SESSION_PATTERN.test(record.sessionId)) {
      return "sessionId is not a session identifier."
    }
    report.sessionId = record.sessionId
  }
  return report
}

export async function POST(request: NextRequest) {
  const auth = await requireTallyPermission(request, "inventory.read")
  if (!auth.ok) return auth.response

  let text: string
  try {
    text = await request.text()
  } catch {
    return invalid("The report could not be read.")
  }
  if (text.length > MAX_BODY_CHARS) return invalid("The report is too large.")

  let parsed: unknown
  try {
    parsed = text.trim() ? JSON.parse(text) : {}
  } catch {
    return invalid("The report is not valid JSON.")
  }

  const report = readReport(parsed)
  if (typeof report === "string") return invalid(report)

  // One bucket per actor: a page that retries in a loop must not become a log
  // amplifier, and the limit is high enough that a real cut-over never hits it.
  const decision = await consumeRateLimits([
    {
      scope: "tally-diagnostics",
      identifier: `${auth.tenantId}:${auth.actorId}`,
      limit: 60,
      windowSeconds: 60,
    },
  ])
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Too many diagnostics frames.", code: "TALLY_DIAGNOSTIC_RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(decision.retryAfter) } },
    )
  }

  logTallyFailure(
    "tally.client.failed",
    {
      step: report.step,
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      ...(report.outcome ? { outcome: report.outcome } : {}),
      ...(report.code ? { code: report.code } : {}),
      ...(report.status ? { status: report.status } : {}),
      ...(report.sessionId ? { sessionId: report.sessionId } : {}),
    },
    report.code ?? report.outcome ?? report.step,
  )

  return NextResponse.json({ ok: true }, { status: 202 })
}

export const dynamic = "force-dynamic"
