import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin } from "@synapse/db/admin"
import {
  CLINICAL_DOCUMENT_TYPES,
  assertSameTenant,
  clinicalDocumentFromRow,
  clinicalDocumentToRow,
  createClinicalDocument,
} from "@synapse/db/clinical-documents"
import { clinicalDocumentTimelineEvent, publishClinicalTimelineBestEffort } from "@synapse/db/clinical-timeline"
import { publishTimelineEvent } from "@synapse/db/identity-persist"
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().optional(),
  person_id: z.string().uuid().optional(),
  document_type: z.enum(CLINICAL_DOCUMENT_TYPES),
  template_id: z.string().min(1).max(120),
  template_version: z.string().min(1).max(40),
  country_pack: z.string().max(80).optional(),
  structured_payload: z.record(z.string(), z.unknown()).default({}),
  rendered_snapshot: z.string().min(1).max(200_000),
})

export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, "encounter", "create", "opd")
  if (cap) return cap

  const patientId = req.nextUrl.searchParams.get("patient_id")
  const encounterId = req.nextUrl.searchParams.get("encounter_id")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db.from("clinical_documents").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(50)
  if (patientId) query = query.eq("patient_id", patientId)
  if (encounterId) query = query.eq("encounter_id", encounterId)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ documents: (data ?? []).map((row: Record<string, unknown>) => clinicalDocumentFromRow(row)) })
}

export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, "encounter", "create", "opd")
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "opd")
  if (moduleBlock) return moduleBlock

  const parsed = createSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: patient } = await db
    .from("patients")
    .select("id, person_id")
    .eq("id", parsed.data.patient_id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle()
  if (!patient) return NextResponse.json({ error: "Patient not found" }, { status: 404 })

  if (parsed.data.encounter_id) {
    const { data: encounter } = await db
      .from("encounters")
      .select("id, patient_id")
      .eq("id", parsed.data.encounter_id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle()
    if (!encounter || encounter.patient_id !== parsed.data.patient_id) {
      return NextResponse.json({ error: "Encounter not found for patient" }, { status: 404 })
    }
  }

  const document = createClinicalDocument({
    tenantId: ctx.tenantId,
    facilityId: ctx.hospitalId,
    patientId: parsed.data.patient_id,
    personId: parsed.data.person_id ?? patient.person_id ?? null,
    encounterId: parsed.data.encounter_id ?? null,
    authorId: ctx.userId,
    documentType: parsed.data.document_type,
    templateId: parsed.data.template_id,
    templateVersion: parsed.data.template_version,
    countryPack: parsed.data.country_pack ?? null,
    structuredPayload: parsed.data.structured_payload,
    renderedSnapshot: parsed.data.rendered_snapshot,
  })
  assertSameTenant(document, ctx.tenantId)

  const { error } = await db.from("clinical_documents").insert(clinicalDocumentToRow(document))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logHospitalAudit({
    ctx,
    action: "INSERT",
    tableName: "clinical_documents",
    recordId: document.id,
    newValue: { document_type: document.documentType, status: document.status },
  })
  void publishClinicalTimelineBestEffort(
    publishTimelineEvent,
    clinicalDocumentTimelineEvent({
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      patientId: document.patientId,
      encounterId: document.encounterId,
      documentId: document.id,
      documentType: document.documentType,
      status: document.status,
      createdBy: ctx.userId,
    }),
  )
  return NextResponse.json({ document }, { status: 201 })
}
