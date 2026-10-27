import { NextRequest, NextResponse } from "next/server"
import { assertCallerCannotSupplyTenant } from "@synapse/interop"
import { getCurrentUser } from "../../../../../lib/auth/getCurrentUser"
import {
  adviseClinical,
  buildClinicalContext,
  clinicalIntelligenceDisabledResponse,
  isClinicalIntelligenceWave1EnabledForTenant,
  recordClinicianOverride,
} from "../../../../../lib/clinical-intelligence"
import { checkRateLimit, rateLimiters } from "../../../../../lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * Clinical Intelligence Wave 1 advise endpoint.
 * Feature-flagged OFF by default. Advisory only — never activates pathways or places orders.
 * The gate is the shared helper: global env flag for staging, or the tenant's
 * feature_flags row for a production allowlist.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized", advisory: true }, { status: 401 })
  if (!user.tenantId) {
    return NextResponse.json({ error: "Tenant context required", advisory: true }, { status: 403 })
  }

  if (!(await isClinicalIntelligenceWave1EnabledForTenant(user.tenantId))) {
    return NextResponse.json(clinicalIntelligenceDisabledResponse(), { status: 503 })
  }

  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const { success } = await checkRateLimit(rateLimiters.ai, ip)
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    assertCallerCannotSupplyTenant(
      typeof body.tenantId === "string" ? body.tenantId : undefined,
      user.tenantId,
    )
  } catch {
    return NextResponse.json({ error: "Caller-supplied tenantId is not accepted" }, { status: 403 })
  }

  if (body.override && typeof body.override === "object") {
    const o = body.override as Record<string, unknown>
    const record = recordClinicianOverride({
      recommendationId: String(o.recommendationId ?? ""),
      decision: (o.decision as "ACCEPT" | "MODIFY" | "REJECT" | "DEFER") ?? "DEFER",
      clinicianId: user.id,
      reason: typeof o.reason === "string" ? o.reason : null,
      modifiedText: typeof o.modifiedText === "string" ? o.modifiedText : null,
    })
    return NextResponse.json({ ok: true, advisory: true, override: record })
  }

  const complaint = typeof body.presentingComplaint === "string" ? body.presentingComplaint : ""
  if (!complaint.trim()) {
    return NextResponse.json({ error: "presentingComplaint is required" }, { status: 400 })
  }

  try {
    const packet = buildClinicalContext({
      tenantId: user.tenantId,
      clinicianId: user.id,
      patientId: typeof body.patientId === "string" ? body.patientId : undefined,
      encounterId: typeof body.encounterId === "string" ? body.encounterId : null,
      facilityId: typeof body.facilityId === "string" ? body.facilityId : null,
      presentingComplaint: complaint,
      vitals: (body.vitals as Record<string, number | string | undefined>) ?? undefined,
      laboratory: body.laboratory as
        | Array<{ test: string; value: string; flag?: string }>
        | undefined,
      history: Array.isArray(body.history) ? body.history.map(String) : undefined,
      examination: Array.isArray(body.examination) ? body.examination.map(String) : undefined,
      medications: Array.isArray(body.medications) ? body.medications.map(String) : undefined,
      allergies: Array.isArray(body.allergies) ? body.allergies.map(String) : undefined,
      previousDiagnoses: Array.isArray(body.previousDiagnoses)
        ? body.previousDiagnoses.map(String)
        : undefined,
      demographics: body.demographics as { age?: number | null; sex?: string | null } | undefined,
    })

    const advice = await adviseClinical({
      packet,
      task: body.task === "pathway_copilot" || body.task === "coding_copilot" ? body.task : "clinical_copilot",
      forceMock: body.forceMock === true,
    })
    return NextResponse.json(advice)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Advice failed"
    return NextResponse.json({ error: message, advisory: true }, { status: 400 })
  }
}
