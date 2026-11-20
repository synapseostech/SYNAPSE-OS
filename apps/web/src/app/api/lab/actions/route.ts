import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/getCurrentUser"
import { hasPlatformAdminAccess } from "@/lib/platform/auth"
import { getSimulationEngine } from "@/lib/platform/simulation-runtime"
import { capabilityForLabAction, isLabContextError, peekLabSessionClaims, requireLabAccess } from "@/lib/lab/access"
import { isLabAction, LabActionError, runLabAction } from "@/lib/lab/engine"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const claims = await peekLabSessionClaims()
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const orderId = String(body.orderId ?? "")
  const action = String(body.action ?? "")

  // Platform operators drive the simulation engine; the session is validated
  // here because the lab_access() check below is skipped for them.
  const operator = hasPlatformAdminAccess(claims.role, claims.email) ? await getCurrentUser() : null
  if (operator && hasPlatformAdminAccess(operator.role, operator.email)) {
    const user = operator
    const engine = getSimulationEngine()
    try {
      if (action === "collect") {
        const accession = String(body.accessionNumber ?? `DEMO-${Date.now()}`)
        engine.lab.collect(orderId, accession, accession.replace(/[^A-Z0-9]/gi, ""), crypto.randomUUID())
      } else if (action === "receive") {
        engine.lab.receive(orderId)
      } else if (action === "reject") {
        const reason = String(body.reason ?? "other")
        engine.lab.reject(orderId, reason as "other", String(body.note ?? body.reason ?? "rejected"))
      } else if (action === "enter_result") {
        engine.lab.enterResult({
          resultId: crypto.randomUUID(),
          orderId,
          value: String(body.value ?? ""),
          analyzer: typeof body.analyzer === "string" ? body.analyzer : "manual",
        })
      } else if (action === "verify") {
        engine.lab.verify(orderId, user.id)
      } else if (action === "release") {
        engine.lab.release(orderId)
      } else if (action === "acknowledge") {
        engine.lab.acknowledgeCritical({
          id: crypto.randomUUID(),
          orderId,
          acknowledgedBy: user.id,
          note: String(body.note ?? "acknowledged"),
        })
      } else {
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
      }
      const order = engine.lab.getOrder(orderId)
      const result = engine.lab.snapshot().results.find((row) => row.labOrderId === orderId) ?? null
      return NextResponse.json({ order, result, source: "simulation" })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "lab_action_failed" },
        { status: 400 },
      )
    }
  }

  if (!isLabAction(action)) return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  const ctx = await requireLabAccess(capabilityForLabAction(action))
  if (isLabContextError(ctx)) return ctx

  try {
    // Order, specimen, result, report and the audit row commit together in
    // lab_commit_action, so there is no separate audit step that can fail
    // after the change is saved.
    const outcome = await runLabAction({ ctx, orderId, action, extra: body })
    const response: Record<string, unknown> = {
      order: outcome.order,
      result: outcome.result,
      source: "database",
      idempotent: outcome.idempotent,
      reportId: outcome.reportId,
      critical: outcome.critical,
    }
    if (action === "collect" && outcome.order.accessionNumber) {
      response.labelUrl = `/api/lab/orders/${outcome.order.id}/label`
    }
    if (outcome.warnings.length) response.warnings = outcome.warnings
    return NextResponse.json(response)
  } catch (err) {
    if (err instanceof LabActionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "lab_action_failed" }, { status: 500 })
  }
}
