import { NextResponse } from "next/server"
import { LAB_SENIOR_ROLES, LAB_STAFF_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

const canRead = LAB_STAFF_ROLES
const canWrite = LAB_SENIOR_ROLES

async function context() {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!canRead.has(ctx.role)) return NextResponse.json({ error: "Lab access required" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  return blocked ?? ctx
}

export async function GET(request: Request) {
  const ctx = await context()
  if (isContextError(ctx) || ctx instanceof NextResponse) return ctx
  const query = new URL(request.url).searchParams
  const db = supabaseAdmin as any
  let builder = db.from("lab_device_test_mappings").select("*").eq("tenant_id", ctx.tenantId)
  if (query.get("deviceId")) builder = builder.eq("device_id", query.get("deviceId"))
  if (query.get("analyzerCode")) builder = builder.ilike("analyzer_code", `%${query.get("analyzerCode")}%`)
  const { data, error } = await builder.order("analyzer_code")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ mappings: data ?? [] })
}

export async function POST(request: Request) {
  const ctx = await context()
  if (isContextError(ctx) || ctx instanceof NextResponse) return ctx
  if (!canWrite.has(ctx.role)) return NextResponse.json({ error: "Mapping administration requires Lab Scientist or manager access" }, { status: 403 })
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : ""
  const analyzerCode = typeof body.analyzerCode === "string" ? body.analyzerCode.trim() : ""
  const loincCode = typeof body.loincCode === "string" ? body.loincCode.trim() : ""
  if (!deviceId || !analyzerCode || !loincCode) return NextResponse.json({ error: "deviceId, analyzerCode and loincCode are required" }, { status: 400 })
  const db = supabaseAdmin as any
  const { data: device } = await db.from("lab_devices").select("id").eq("id", deviceId).eq("tenant_id", ctx.tenantId).eq("facility_id", ctx.hospitalId).maybeSingle()
  if (!device) return NextResponse.json({ error: "Device is outside the current facility" }, { status: 404 })
  const { data, error } = await db.from("lab_device_test_mappings").insert({
    tenant_id: ctx.tenantId, device_id: deviceId, analyzer_code: analyzerCode,
    analyzer_name: typeof body.analyzerName === "string" ? body.analyzerName.trim() : null,
    loinc_code: loincCode, catalog_test_id: typeof body.catalogTestId === "string" ? body.catalogTestId.trim() : null,
    unit: typeof body.unit === "string" ? body.unit.trim() : null, approved_by: ctx.userId,
    approved_at: new Date().toISOString(), active: true,
  }).select("*").single()
  if (error) return NextResponse.json({ error: /duplicate|unique/i.test(error.message) ? "An active mapping already exists for this device and analyzer code" : error.message }, { status: 409 })
  await logHospitalAudit({ ctx, action: "LAB_MAPPING_CREATED", tableName: "lab_device_test_mappings", recordId: data.id, newValue: { device_id: deviceId, analyzer_code: analyzerCode, loinc_code: loincCode } })
  return NextResponse.json({ mapping: data }, { status: 201 })
}
