import { NextResponse } from "next/server"
import { LAB_SENIOR_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_SENIOR_ROLES.has(ctx.role)) return NextResponse.json({ error: "Lab mapping review required" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked
  const { id } = await params
  const db = supabaseAdmin as any
  const { data: staging } = await db.from("lab_result_staging").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!staging) return NextResponse.json({ error: "Staging result not found" }, { status: 404 })
  const { data: mapping } = await db.from("lab_device_test_mappings").select("loinc_code, analyzer_name").eq("tenant_id", ctx.tenantId).eq("device_id", staging.device_id).eq("analyzer_code", staging.analyzer_code).eq("active", true).maybeSingle()
  let labOrderId: string | null = null
  let status = "UNMAPPED"
  if (mapping && staging.accession_number) {
    const { data: specimen } = await db.from("lab_specimens").select("lab_order_id").eq("tenant_id", ctx.tenantId).eq("accession_number", staging.accession_number).maybeSingle()
    if (specimen?.lab_order_id) {
      const { data: order } = await db.from("lab_orders").select("id, encounter_id").eq("id", specimen.lab_order_id).eq("tenant_id", ctx.tenantId).maybeSingle()
      const { data: encounter } = order ? await db.from("encounters").select("id").eq("id", order.encounter_id).eq("tenant_id", ctx.tenantId).eq("hospital_id", ctx.hospitalId).maybeSingle() : { data: null }
      if (order && encounter) { labOrderId = order.id; status = "READY_FOR_REVIEW" }
    }
  } else if (mapping) {
    status = "UNMATCHED"
  }
  const updates = { mapped_loinc: mapping?.loinc_code ?? null, mapped_test_name: mapping?.analyzer_name ?? null, lab_order_id: labOrderId, status, updated_at: new Date().toISOString() }
  const { data, error } = await db.from("lab_result_staging").update(updates).eq("id", id).eq("tenant_id", ctx.tenantId).select("*").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logHospitalAudit({ ctx, action: "LAB_STAGING_REPROCESSED", tableName: "lab_result_staging", recordId: id, newValue: { status, lab_order_id: labOrderId, mapped_loinc: updates.mapped_loinc } })
  return NextResponse.json({ staging: data, rawMessagePreserved: true })
}
