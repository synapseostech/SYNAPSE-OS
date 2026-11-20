import { NextRequest, NextResponse } from "next/server"
import { LAB_CLINICIAN_ROLES, LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { logHospitalAudit } from "@/lib/hospital-shared/audit"
import { isLabContextError, requireLabAccess } from "@/lib/lab/access"

export const dynamic = "force-dynamic"

/**
 * Critical value acknowledged: by the lab (who phoned it through) or by the
 * clinician (who received it). The first acknowledgement of each kind is kept.
 * One guarded update: a non-critical or another tenant's result matches nothing.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess(null)
  if (isLabContextError(ctx)) return ctx
  const scientist = LAB_SENIOR_ROLES.has(ctx.role)
  const clinician = LAB_CLINICIAN_ROLES.has(ctx.role)
  if (!scientist && !clinician) return NextResponse.json({ error: "Critical-value acknowledgement requires scientist or clinician access" }, { status: 403 })
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Result not found" }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { note?: string }
  const now = new Date().toISOString()
  const [atColumn, byColumn] = scientist
    ? ["critical_scientist_ack_at", "critical_scientist_ack_by"]
    : ["critical_clinician_ack_at", "critical_clinician_ack_by"]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("lab_results")
    .update({ [atColumn]: now, [byColumn]: ctx.userId })
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .eq("is_critical", true)
    .is(atColumn, null)
    .select("id, critical_scientist_ack_at, critical_clinician_ack_at")
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) {
    return NextResponse.json({ error: "No unacknowledged critical result with this id", code: "LAB_NOT_CRITICAL_OR_ALREADY_ACKNOWLEDGED" }, { status: 404 })
  }
  await logHospitalAudit({ ctx, action: scientist ? "LAB_CRITICAL_SCIENTIST_ACK" : "LAB_CRITICAL_CLINICIAN_ACK", tableName: "lab_results", recordId: id, newValue: { at: now, note: String(body.note ?? "").slice(0, 500) || null } })
  return NextResponse.json({ result: data })
}
