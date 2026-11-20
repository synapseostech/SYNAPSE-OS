import { NextResponse } from "next/server"
import { LAB_SENIOR_ROLES, LAB_STAFF_ROLES } from "@/lib/lab/roles"
import { supabaseAdmin } from "@synapse/db/admin"
import { isContextError, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_STAFF_ROLES.has(ctx.role)) return NextResponse.json({ error: "Lab access required" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked
  const accession = new URL(request.url).searchParams.get("accession")?.trim()
  if (!accession) return NextResponse.json({ candidates: [] })
  const db = supabaseAdmin as any
  const { data: specimens } = await db.from("lab_specimens").select("accession_number, lab_order_id, patient_id, collected_at").eq("tenant_id", ctx.tenantId).eq("accession_number", accession)
  const orderIds = (specimens ?? []).map((row: { lab_order_id?: string }) => row.lab_order_id).filter(Boolean)
  if (!orderIds.length) return NextResponse.json({ candidates: [] })
  const { data: orders } = await db.from("lab_orders").select("id, accession_number, encounter_id, patient_id, test_name, ordered_at").eq("tenant_id", ctx.tenantId).in("id", orderIds)
  const candidates = []
  for (const order of orders ?? []) {
    const { data: encounter } = await db.from("encounters").select("id, hospital_id").eq("id", order.encounter_id).eq("tenant_id", ctx.tenantId).eq("hospital_id", ctx.hospitalId).maybeSingle()
    if (!encounter) continue
    const { data: patient } = await db.from("patients").select("id, full_name, mrn, dob").eq("id", order.patient_id).eq("tenant_id", ctx.tenantId).maybeSingle()
    candidates.push({ order, patient, encounter })
  }
  return NextResponse.json({ candidates })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  if (!LAB_SENIOR_ROLES.has(ctx.role)) return NextResponse.json({ error: "Lab scientist reconciliation required" }, { status: 403 })
  const blocked = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "lab")
  if (blocked) return blocked
  const body = await request.json().catch(() => ({})) as { accessionNumber?: string; confirm?: boolean; notes?: string }
  if (body.confirm !== true || !body.accessionNumber?.trim()) return NextResponse.json({ error: "Explicit confirmation and accessionNumber are required" }, { status: 400 })
  const { id } = await params
  const db = supabaseAdmin as any
  const { data: staging } = await db.from("lab_result_staging").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!staging) return NextResponse.json({ error: "Staging result not found" }, { status: 404 })
  const { data: specimen } = await db.from("lab_specimens").select("lab_order_id").eq("tenant_id", ctx.tenantId).eq("accession_number", body.accessionNumber.trim()).maybeSingle()
  const { data: order } = specimen?.lab_order_id ? await db.from("lab_orders").select("id, encounter_id").eq("id", specimen.lab_order_id).eq("tenant_id", ctx.tenantId).maybeSingle() : { data: null }
  const { data: encounter } = order ? await db.from("encounters").select("id").eq("id", order.encounter_id).eq("tenant_id", ctx.tenantId).eq("hospital_id", ctx.hospitalId).maybeSingle() : { data: null }
  if (!order || !encounter) return NextResponse.json({ error: "Accession is not valid in the current facility" }, { status: 404 })
  const { data: mapping } = await db.from("lab_device_test_mappings").select("loinc_code, analyzer_name").eq("tenant_id", ctx.tenantId).eq("device_id", staging.device_id).eq("analyzer_code", staging.analyzer_code).eq("active", true).maybeSingle()
  const at = new Date().toISOString()
  const { data, error } = await db.from("lab_result_staging").update({ accession_number: body.accessionNumber.trim(), lab_order_id: order.id, mapped_loinc: mapping?.loinc_code ?? staging.mapped_loinc, mapped_test_name: mapping?.analyzer_name ?? staging.mapped_test_name, status: mapping ? "READY_FOR_REVIEW" : "UNMAPPED", matched_by: ctx.userId, matched_at: at, previous_accession: staging.accession_number, reconciliation_notes: body.notes?.trim() || null, updated_at: at }).eq("id", id).eq("tenant_id", ctx.tenantId).select("*").single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logHospitalAudit({ ctx, action: "LAB_ACCESSION_RECONCILED", tableName: "lab_result_staging", recordId: id, oldValue: { accession_number: staging.accession_number }, newValue: { accession_number: body.accessionNumber.trim(), lab_order_id: order.id, notes: body.notes?.trim() || null } })
  return NextResponse.json({ staging: data, matched: true })
}
