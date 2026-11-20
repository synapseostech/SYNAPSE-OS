import { NextResponse } from "next/server"
import { LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_SENIOR_ROLES.has(ctx.role)) return NextResponse.json({ error: "Mapping administration requires Lab Scientist or manager access" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const updates: Record<string, unknown> = {}
  if (typeof body.loincCode === "string") updates.loinc_code = body.loincCode.trim()
  if (typeof body.analyzerName === "string") updates.analyzer_name = body.analyzerName.trim()
  if (typeof body.catalogTestId === "string") updates.catalog_test_id = body.catalogTestId.trim()
  if (typeof body.unit === "string") updates.unit = body.unit.trim()
  if (typeof body.active === "boolean") updates.active = body.active
  if (!Object.keys(updates).length) return NextResponse.json({ error: "No mapping changes supplied" }, { status: 400 })
  const { id } = await params
  const db = supabaseAdmin as any
  const { data: previous } = await db.from("lab_device_test_mappings").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!previous) return NextResponse.json({ error: "Mapping not found" }, { status: 404 })
  updates.approved_by = ctx.userId
  updates.approved_at = new Date().toISOString()
  const { data, error } = await db.from("lab_device_test_mappings").update(updates).eq("id", id).eq("tenant_id", ctx.tenantId).select("*").single()
  if (error) return NextResponse.json({ error: /duplicate|unique/i.test(error.message) ? "An active mapping already exists for this device and analyzer code" : error.message }, { status: 409 })
  await logHospitalAudit({ ctx, action: updates.active === false ? "LAB_MAPPING_DISABLED" : "LAB_MAPPING_UPDATED", tableName: "lab_device_test_mappings", recordId: id, oldValue: { loinc_code: previous.loinc_code, active: previous.active }, newValue: { loinc_code: data.loinc_code, active: data.active } })
  return NextResponse.json({ mapping: data })
}
