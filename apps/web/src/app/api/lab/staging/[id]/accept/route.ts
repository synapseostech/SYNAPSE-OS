import { NextRequest, NextResponse } from "next/server"
import { LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isLabContextError, requireLabAccess } from "@/lib/lab/access"
import { LabActionError, runLabAction } from "@/lib/lab/engine"

export const dynamic = "force-dynamic"

/**
 * A scientist accepts an analyser result into the order it was matched to.
 * The result is entered through the same engine as a manual result (one
 * commit with the audit row) and still needs verification; nothing here
 * releases. Previously the staging row update wrote columns that did not
 * exist, so acceptance saved the result and then failed, and any analyte under
 * the accession could land on the order.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess("result.enter")
  if (isLabContextError(ctx)) return ctx
  if (!LAB_SENIOR_ROLES.has(ctx.role)) {
    return NextResponse.json({ error: "Lab scientist review required" }, { status: 403 })
  }

  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Staging result not found" }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: staging, error } = await db
    .from("lab_result_staging")
    .select("id, status, lab_order_id, mapped_loinc, value, device_id, clinical_result_id")
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!staging) return NextResponse.json({ error: "Staging result not found" }, { status: 404 })
  if (staging.status === "ACCEPTED" && staging.clinical_result_id) {
    return NextResponse.json({ stagingId: id, accepted: true, alreadyAccepted: true, clinicalResultId: staging.clinical_result_id })
  }
  if (staging.status !== "READY_FOR_REVIEW") return NextResponse.json({ error: "Staging result must be mapped and accession-matched before acceptance" }, { status: 409 })
  if (!staging.lab_order_id || !staging.mapped_loinc || !staging.value) return NextResponse.json({ error: "Staging result is incomplete" }, { status: 409 })

  let outcome
  try {
    outcome = await runLabAction({
      ctx,
      orderId: String(staging.lab_order_id),
      action: "enter_result",
      extra: { value: String(staging.value), source: "ANALYZER", analyzer: String(staging.device_id ?? "analyzer"), expectLoinc: String(staging.mapped_loinc) },
    })
  } catch (err) {
    if (err instanceof LabActionError) {
      const status = err.code === "LAB_ORDER_NOT_FOUND" ? 404 : err.status
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "accept_failed" }, { status: 500 })
  }

  const reviewedAt = new Date().toISOString()
  const { error: stageError } = await db
    .from("lab_result_staging")
    .update({ status: "ACCEPTED", reviewed_by: ctx.userId, reviewed_at: reviewedAt, clinical_result_id: outcome.result?.id ?? null, updated_at: reviewedAt })
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .eq("status", "READY_FOR_REVIEW")
  if (stageError) {
    return NextResponse.json({ error: stageError.message, clinicalResultId: outcome.result?.id ?? null, note: "Result entered; staging row not marked" }, { status: 500 })
  }
  return NextResponse.json({ stagingId: id, accepted: true, clinicalResultId: outcome.result?.id ?? null, orderId: outcome.order.id, workflowStatus: outcome.order.status, critical: outcome.critical })
}
