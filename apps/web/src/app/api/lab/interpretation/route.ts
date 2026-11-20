import { NextRequest, NextResponse } from "next/server"
import { LAB_CLINICIAN_ROLES, LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import {
  assertCallerCannotSupplyTenant,
  assertNotForbidden,
  authorizePacketTenant,
  buildRecommendation,
  type PatientContextPacket,
} from "@synapse/interop"
import { isContextError, gateHospitalModule } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

const SAFETY = "AI decision support only. Does not verify or release results."

export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!(LAB_SENIOR_ROLES.has(ctx.role) || LAB_CLINICIAN_ROLES.has(ctx.role))) {
    return NextResponse.json({ error: "Lab interpretation requires scientist, manager, or clinician access" }, { status: 403 })
  }
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked

  const body = await req.json().catch(() => ({})) as {
    resultId?: string
    stagingId?: string
    tenantId?: string
    forbiddenAction?: string
  }

  try {
    if (body.forbiddenAction) assertNotForbidden(body.forbiddenAction)
    assertCallerCannotSupplyTenant(body.tenantId, ctx.tenantId)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Forbidden"
    return NextResponse.json({ error: message, label: SAFETY }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let laboratory: Array<{ test: string; value: string; flag?: string }> = []
  let patientId = "unknown"
  let encounterId: string | null = null

  if (body.resultId) {
    const { data: result } = await db.from("lab_results").select("id, test_name, result_value, abnormal_flag, is_critical, lab_order_id").eq("id", body.resultId).eq("tenant_id", ctx.tenantId).maybeSingle()
    if (!result) return NextResponse.json({ error: "Result not found" }, { status: 404 })
    const { data: order } = await db.from("lab_orders").select("patient_id, encounter_id").eq("id", result.lab_order_id).eq("tenant_id", ctx.tenantId).maybeSingle()
    if (!order) return NextResponse.json({ error: "Result not found" }, { status: 404 })
    patientId = order.patient_id
    encounterId = order.encounter_id
    laboratory = [{ test: result.test_name, value: String(result.result_value ?? ""), flag: result.is_critical ? "critical" : result.abnormal_flag ?? undefined }]
  } else if (body.stagingId) {
    const { data: staging } = await db.from("lab_result_staging").select("id, mapped_test_name, analyzer_code, value, flags, lab_order_id").eq("id", body.stagingId).eq("tenant_id", ctx.tenantId).maybeSingle()
    if (!staging) return NextResponse.json({ error: "Staging result not found" }, { status: 404 })
    if (staging.lab_order_id) {
      const { data: order } = await db.from("lab_orders").select("patient_id, encounter_id").eq("id", staging.lab_order_id).eq("tenant_id", ctx.tenantId).maybeSingle()
      if (order) {
        patientId = order.patient_id
        encounterId = order.encounter_id
      }
    }
    laboratory = [{ test: staging.mapped_test_name ?? staging.analyzer_code ?? "analyzer result", value: String(staging.value ?? ""), flag: staging.flags?.critical ? "critical" : undefined }]
  } else {
    return NextResponse.json({ error: "resultId or stagingId required" }, { status: 400 })
  }

  const packet: PatientContextPacket = {
    patientId,
    tenantId: ctx.tenantId,
    encounterId,
    clinicianId: ctx.userId,
    presentingComplaint: "Laboratory result review",
    laboratory,
  }
  try {
    authorizePacketTenant(packet, ctx.tenantId)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Tenant mismatch" }, { status: 403 })
  }

  try {
    const hay = laboratory.map((row) => row.test).join(" ")
    const recommendation = buildRecommendation({
      id: crypto.randomUUID(),
      task: "lab_interpretation",
      proposal: {
        conditionName: /wbc|leuk/i.test(hay) ? "leukocytosis pattern" : "lab pattern review",
        cantMiss: laboratory.some((row) => row.flag === "critical"),
        confidence: 0.45,
        aiReasoning: "May be consistent with the recorded laboratory pattern. Consider the clinical context. This is decision support only and does not verify or release the result.",
      },
      packet,
      model: "synthetic-fallback",
    })
    return NextResponse.json({
      ok: true,
      provider: "synthetic-fallback",
      fallback: true,
      label: SAFETY,
      recommendation,
      analysis: {
        summary: recommendation.reasoningSummary,
        abnormal_findings: laboratory.filter((row) => row.flag && row.flag !== "N").map((row) => `${row.test} ${row.value}`),
        critical_findings: laboratory.filter((row) => row.flag === "critical").map((row) => `${row.test} ${row.value}`),
        trend: "Trend comparison requires compatible previous verified results.",
        pattern: recommendation.recommendation,
        possible_relevance: "May be consistent with the recorded pattern; consider clinical correlation.",
        supporting_evidence: recommendation.supportingEvidence,
        contradicting_evidence: recommendation.contradictingEvidence,
        missing_information: recommendation.missingInformation,
        suggested_follow_up: "Human scientist verification and clinician review remain required.",
        suggested_pathway: recommendation.suggestedPathwayId,
        confidence: recommendation.confidence,
        provenance: recommendation.provenance,
      },
    })
  } catch {
    return NextResponse.json({
      ok: false,
      unavailable: true,
      label: "AI assistance unavailable",
      note: "Human Lab verification and release remain available.",
    })
  }
}
