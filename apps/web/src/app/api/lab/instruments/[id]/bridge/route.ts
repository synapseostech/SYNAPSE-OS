import { NextRequest, NextResponse } from "next/server"
import { LAB_MANAGER_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { LabBridgeHashSecretMissingError, issueBridgeSecret } from "@synapse/db/lab-device-intelligence"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_MANAGER_ROLES.has(ctx.role)) {
    return NextResponse.json({ error: "Credential rotation requires Lab Manager or Hospital Admin" }, { status: 403 })
  }
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked
  const { id } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: device } = await db.from("lab_devices").select("id, name").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 })

  let issued: { secret: string; hash: string; prefix: string }
  try {
    issued = issueBridgeSecret()
  } catch (err) {
    if (err instanceof LabBridgeHashSecretMissingError) {
      return NextResponse.json({ error: "Lab Edge hashed credentials unavailable" }, { status: 503 })
    }
    throw err
  }

  const revokedAt = new Date().toISOString()
  await db.from("lab_instrument_bridges").update({
    is_active: false,
    revoked_at: revokedAt,
  }).eq("tenant_id", ctx.tenantId).eq("device_id", id).eq("is_active", true)

  const { data: bridge, error } = await db.from("lab_instrument_bridges").insert({
    tenant_id: ctx.tenantId,
    name: `${device.name} edge`,
    device_id: id,
    api_key: null,
    api_key_hash: issued.hash,
    api_key_prefix: issued.prefix,
    is_active: true,
    connection_type: "tcp",
  }).select("id, api_key_prefix, created_at").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logHospitalAudit({ ctx, action: "LAB_BRIDGE_CREDENTIAL_ROTATED", tableName: "lab_instrument_bridges", recordId: bridge.id, newValue: { device_id: id, prefix: issued.prefix } })
  return NextResponse.json({
    bridgeId: bridge.id,
    prefix: issued.prefix,
    secret: issued.secret,
    rotatedAt: bridge.created_at ?? revokedAt,
    note: "Copy this secret now. It is not stored in plaintext and will not be shown again. The prefix is an identifier, not a credential.",
  }, { status: 201 })
}
