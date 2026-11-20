import { NextRequest, NextResponse } from "next/server"
import { LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_SENIOR_ROLES.has(ctx.role)) return NextResponse.json({ error: "Lab scientist review required" }, { status: 403 })
  const cap = await requireHospitalCapability(ctx, "result", "enter", "lab")
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (moduleBlock) return moduleBlock
  const body = await req.json().catch(() => null) as { reason?: string } | null
  if (!body?.reason?.trim()) return NextResponse.json({ error: "Rejection reason is required" }, { status: 400 })
  const { id } = await params
  const at = new Date().toISOString()
  const db = supabaseAdmin as any
  const { data, error } = await db.from("lab_result_staging").update({ status: "REJECTED", reviewed_by: ctx.userId, reviewed_at: at, rejection_reason: body.reason.trim(), updated_at: at }).eq("id", id).eq("tenant_id", ctx.tenantId).in("status", ["READY_FOR_REVIEW", "UNMAPPED", "UNMATCHED", "VALIDATION_FAILED"]).select("id, status, reviewed_by, reviewed_at, rejection_reason").maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Staging result not found or already finalized" }, { status: 404 })
  await logHospitalAudit({ ctx, action: "ANALYZER_RESULT_REJECTED", tableName: "lab_result_staging", recordId: id, newValue: { reason: body.reason.trim() } })
  return NextResponse.json({ stagingId: id, rejected: true, rejectedAt: at })
}