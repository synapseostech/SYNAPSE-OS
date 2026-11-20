import { NextRequest, NextResponse } from "next/server"
import { LAB_MANAGER_ROLES, LAB_STAFF_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { assertDeviceValidationTransition, omitDeviceSecrets, type LabValidationStatus } from "@synapse/db/lab-device-intelligence"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

const canWrite = LAB_MANAGER_ROLES

async function ctxOrError(write = false) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_STAFF_ROLES.has(ctx.role)) {
    return NextResponse.json({ error: "Lab access required" }, { status: 403 })
  }
  if (write && !canWrite.has(ctx.role)) return NextResponse.json({ error: "Device administration requires Lab Manager or Hospital Admin" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  return blocked ?? ctx
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ctxOrError()
  if (isContextError(ctx) || ctx instanceof NextResponse) return ctx
  const { id } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: device, error } = await db.from("lab_devices").select("id, name, manufacturer, model, serial_number, section, connection_type, protocol, validation_status, active, last_seen_at, last_message_at, mapping_profile, configuration, host, port, serial_port, baud_rate").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 })
  const { data: bridge } = await db.from("lab_instrument_bridges").select("id, heartbeat_at, service_state, queue_summary, edge_version, last_successful_upload, api_key_prefix, is_active, revoked_at").eq("tenant_id", ctx.tenantId).eq("device_id", id).maybeSingle()
  const { count: mapped } = await db.from("lab_device_test_mappings").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("device_id", id).eq("active", true)
  const { count: unmapped } = await db.from("lab_result_staging").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantId).eq("device_id", id).eq("status", "UNMAPPED")
  const { data: errors } = await db.from("lab_device_messages").select("id, received_at, parse_status, parse_error, protocol, payload_hash").eq("tenant_id", ctx.tenantId).eq("device_id", id).eq("parse_status", "FAILED").order("received_at", { ascending: false }).limit(10)
  const configuration = (device.configuration ?? {}) as Record<string, unknown>
  const safeConfig = omitDeviceSecrets(configuration)
  return NextResponse.json({
    device: { ...device, configuration: safeConfig },
    bridge: bridge ? { ...bridge, api_key: undefined, api_key_hash: undefined } : null,
    coverage: { mapped: mapped ?? 0, unmapped: unmapped ?? 0 },
    recentErrors: errors ?? [],
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ctxOrError(true)
  if (isContextError(ctx) || ctx instanceof NextResponse) return ctx
  const { id } = await params
  const body = await req.json().catch(() => ({})) as { validationStatus?: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: device } = await db.from("lab_devices").select("id, validation_status").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 })
  const next = body.validationStatus as LabValidationStatus | undefined
  if (!next) return NextResponse.json({ error: "validationStatus required" }, { status: 400 })
  try {
    assertDeviceValidationTransition(device.validation_status, next)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid transition" }, { status: 409 })
  }
  const { data, error } = await db.from("lab_devices").update({
    validation_status: next,
    active: next === "ACTIVE",
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("tenant_id", ctx.tenantId).select("id, validation_status, active").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logHospitalAudit({ ctx, action: "LAB_DEVICE_VALIDATION_CHANGED", tableName: "lab_devices", recordId: id, newValue: { validation_status: next, active: next === "ACTIVE" } })
  return NextResponse.json({ device: data })
}
