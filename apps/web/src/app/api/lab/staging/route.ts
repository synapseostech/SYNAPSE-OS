import { NextResponse } from "next/server"
import { LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, gateHospitalModule } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function GET() {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_SENIOR_ROLES.has(ctx.role)) return NextResponse.json({ error: "Lab scientist review required" }, { status: 403 })
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (moduleBlock) return moduleBlock
  const db = supabaseAdmin as any
  const { data, error } = await db.from("lab_result_staging").select("id, device_id, device_message_id, lab_order_id, accession_number, analyzer_code, mapped_loinc, mapped_test_name, value, unit, flags, instrument_flags, status, created_at, reviewed_by, reviewed_at, rejection_reason").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(100)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const orderIds = [...new Set((data ?? []).map((row: { lab_order_id?: string | null }) => row.lab_order_id).filter(Boolean))]
  const orders = orderIds.length ? (await db.from("lab_orders").select("id, encounter_id, patient_id, test_name").eq("tenant_id", ctx.tenantId).in("id", orderIds)).data ?? [] : []
  const typedOrders = orders as { id: string; encounter_id?: string; patient_id?: string; test_name?: string }[]
  const orderById = new Map(typedOrders.map((order) => [order.id, order]))
  const visible = (data ?? []).filter((row: { lab_order_id?: string | null }) => {
    const order = row.lab_order_id ? orderById.get(row.lab_order_id) : null
    return !order || typedOrders.some((candidate) => candidate.id === order.id && candidate.encounter_id)
  }).map((row: Record<string, unknown>) => ({ ...row, order: row.lab_order_id ? orderById.get(String(row.lab_order_id)) ?? null : null }))
  return NextResponse.json({ staging: visible })
}