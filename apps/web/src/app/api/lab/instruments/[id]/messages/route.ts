import { NextRequest, NextResponse } from "next/server"
import { LAB_STAFF_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, gateHospitalModule } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_STAFF_ROLES.has(ctx.role)) {
    return NextResponse.json({ error: "Lab access required" }, { status: 403 })
  }
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked
  const { id } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: device } = await db.from("lab_devices").select("id").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 })
  const { data, error } = await db
    .from("lab_device_messages")
    .select("id, received_at, protocol, payload_hash, message_control_id, parse_status, processing_status, parse_error, correlation_id")
    .eq("tenant_id", ctx.tenantId)
    .eq("device_id", id)
    .order("received_at", { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ messages: data ?? [] })
}
