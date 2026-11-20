import { NextResponse } from "next/server"
import { LAB_MANAGER_ROLES, LAB_STAFF_ROLES } from "@/lib/lab/roles"
import { getCurrentUser } from "@/lib/auth/getCurrentUser"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { supabaseAdmin } from "@synapse/db/admin"
import {
  LAB_CONNECTION_TYPES,
  deriveDeviceOperationalHealth,
  mappingCoverage,
  omitDeviceSecrets,
  serialConfig,
  tcpConfig,
} from "@synapse/db/lab-device-intelligence"

export const dynamic = "force-dynamic"

const canRead = LAB_STAFF_ROLES
const canWrite = LAB_MANAGER_ROLES

async function labContext(write = false) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!canRead.has(ctx.role)) return NextResponse.json({ error: "Lab access required" }, { status: 403 })
  if (write && !canWrite.has(ctx.role)) return NextResponse.json({ error: "Device administration requires Lab Manager or Hospital Admin" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  return blocked ?? ctx
}

export async function GET() {
  const ctx = await labContext()
  if (isContextError(ctx) || ctx instanceof NextResponse) return ctx

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db
    .from("lab_devices")
    .select("id, name, manufacturer, model, serial_number, section, connection_type, protocol, validation_status, health_status, active, last_seen_at, last_message_at, mapping_profile, configuration")
    .eq("tenant_id", ctx.tenantId)
    .order("name", { ascending: true })
  if (error) return NextResponse.json({ devices: [], warning: error.message })

  const deviceIds = (data ?? []).map((row: { id: string }) => row.id)
  const bridges = deviceIds.length
    ? (await db.from("lab_instrument_bridges").select("device_id, heartbeat_at, service_state, queue_summary, edge_version, last_successful_upload, api_key_prefix, is_active, revoked_at").eq("tenant_id", ctx.tenantId).in("device_id", deviceIds)).data ?? []
    : []
  const mappings = deviceIds.length
    ? (await db.from("lab_device_test_mappings").select("device_id, active").eq("tenant_id", ctx.tenantId).in("device_id", deviceIds)).data ?? []
    : []
  const unmapped = deviceIds.length
    ? (await db.from("lab_result_staging").select("device_id").eq("tenant_id", ctx.tenantId).eq("status", "UNMAPPED").in("device_id", deviceIds)).data ?? []
    : []

  const devices = (data ?? []).map((device: Record<string, unknown>) => {
    const bridge = (bridges as Record<string, unknown>[]).find((row) => row.device_id === device.id)
    const queue = (bridge?.queue_summary ?? {}) as Record<string, number>
    const mappedCount = (mappings as { device_id: string; active: boolean }[]).filter((row) => row.device_id === device.id && row.active).length
    const unmappedCount = (unmapped as { device_id: string }[]).filter((row) => row.device_id === device.id).length
    const configuration = (device.configuration ?? {}) as Record<string, unknown>
    const safeConfig = omitDeviceSecrets(configuration)
    return {
      id: device.id,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      serial_number: device.serial_number,
      section: device.section,
      connection_type: device.connection_type,
      protocol: device.protocol,
      validation_status: device.validation_status,
      active: device.active,
      last_seen_at: device.last_seen_at,
      last_message_at: device.last_message_at,
      mapping_profile: device.mapping_profile,
      configuration: safeConfig,
      edge_version: bridge?.edge_version ?? null,
      service_state: bridge?.service_state ?? null,
      last_successful_upload: bridge?.last_successful_upload ?? null,
      queue_summary: queue,
      credential_prefix: bridge?.api_key_prefix ?? null,
      operational_health: deriveDeviceOperationalHealth({
        validationStatus: String(device.validation_status),
        lastSeenAt: device.last_seen_at ? String(device.last_seen_at) : null,
        lastMessageAt: device.last_message_at ? String(device.last_message_at) : null,
        queueDepth: Number(queue.queueDepth ?? 0),
        failedCount: Number(queue.failedCount ?? 0),
        unmappedCount,
      }),
      coverage: mappingCoverage(mappedCount, unmappedCount),
    }
  })
  return NextResponse.json({ devices })
}

export async function POST(request: Request) {
  const ctx = await labContext(true)
  if (isContextError(ctx) || ctx instanceof NextResponse) return ctx
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const connectionType = typeof body.connectionType === "string" ? body.connectionType : "MANUAL"
  if (!name) return NextResponse.json({ error: "Device name is required" }, { status: 400 })
  if (!(LAB_CONNECTION_TYPES as readonly string[]).includes(connectionType)) {
    return NextResponse.json({ error: "Unsupported connection type" }, { status: 400 })
  }
  const configuration = connectionType === "SERIAL_RS232"
    ? serialConfig({
      port: typeof body.serialPort === "string" ? body.serialPort : undefined,
      baudRate: typeof body.baudRate === "number" ? body.baudRate : undefined,
      dataBits: typeof body.dataBits === "number" ? body.dataBits : undefined,
      parity: typeof body.parity === "string" ? body.parity : undefined,
      stopBits: typeof body.stopBits === "number" ? body.stopBits : undefined,
      flowControl: typeof body.flowControl === "string" ? body.flowControl : undefined,
    })
    : tcpConfig({
      host: typeof body.host === "string" ? body.host : undefined,
      port: typeof body.port === "number" ? body.port : undefined,
      tls: Boolean(body.tls),
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db.from("lab_devices").insert({
    tenant_id: ctx.tenantId,
    facility_id: ctx.hospitalId,
    name,
    manufacturer: typeof body.manufacturer === "string" ? body.manufacturer.trim() : null,
    model: typeof body.model === "string" ? body.model.trim() : null,
    serial_number: typeof body.serialNumber === "string" ? body.serialNumber.trim() : null,
    section: typeof body.section === "string" ? body.section.trim() : null,
    connection_type: connectionType,
    protocol: typeof body.protocol === "string" ? body.protocol : connectionType,
    host: typeof body.host === "string" ? body.host : null,
    port: typeof body.port === "number" ? body.port : null,
    serial_port: typeof body.serialPort === "string" ? body.serialPort : null,
    baud_rate: typeof body.baudRate === "number" ? body.baudRate : null,
    data_bits: typeof body.dataBits === "number" ? body.dataBits : null,
    stop_bits: typeof body.stopBits === "number" ? body.stopBits : null,
    parity: typeof body.parity === "string" ? body.parity : null,
    flow_control: typeof body.flowControl === "string" ? body.flowControl : null,
    mapping_profile: typeof body.mappingProfile === "string" ? body.mappingProfile : null,
    validation_status: "CONFIGURED",
    active: false,
    configuration,
  }).select("id, name, validation_status, connection_type, protocol").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logHospitalAudit({ ctx, action: "LAB_DEVICE_REGISTERED", tableName: "lab_devices", recordId: data.id, newValue: { name, connection_type: connectionType, validation_status: "CONFIGURED" } })
  return NextResponse.json({ device: data }, { status: 201 })
}
