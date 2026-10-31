import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin } from "@synapse/db/admin"
import {
  CLINICAL_DOCUMENT_TYPES,
  assertSameTenant as assertDocumentTenant,
  clinicalDocumentToRow,
  createClinicalDocument,
  signClinicalDocument,
} from "@synapse/db/clinical-documents"
import {
  DEATH_LOCATION_TYPES,
  DEATH_TIME_PRECISIONS,
  MEDICOLEGAL_FLAGS,
  assertCanPronounce,
  assertSameDeathTenant,
  createDeathPronouncement,
  deathPronouncementFromRow,
  deathPronouncementToRow,
  deceasedDisposition,
  renderPronouncementSnapshot,
} from "@synapse/db/death-pronouncement"
import { deathPronouncedTimelineEvent, publishClinicalTimelineBestEffort } from "@synapse/db/clinical-timeline"
import { publishTimelineEvent } from "@synapse/db/identity-persist"
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from "@/lib/hospital-shared"
import { requireHospitalStaffContext } from "@/lib/hospital-dept"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid(),
  person_id: z.string().uuid().optional(),
  death_time_precision: z.enum(DEATH_TIME_PRECISIONS),
  death_date_time: z.string().optional().nullable(),
  death_time_text: z.string().max(240).optional().nullable(),
  location_type: z.enum(DEATH_LOCATION_TYPES),
  ward_id: z.string().uuid().optional().nullable(),
  bed_id: z.string().uuid().optional().nullable(),
  location_text: z.string().max(240).optional().nullable(),
  resuscitation_attempted: z.boolean().optional(),
  resuscitation_started_at: z.string().optional().nullable(),
  resuscitation_stopped_at: z.string().optional().nullable(),
  dnr_status: z.string().max(80).optional().nullable(),
  circumstances: z.string().max(4000).optional().nullable(),
  provisional_cause: z.string().max(500).optional().nullable(),
  contributing_conditions: z.string().max(1000).optional().nullable(),
  external_cause_suspected: z.boolean().optional(),
  traumatic_death: z.boolean().optional(),
  suspicious_death: z.boolean().optional(),
  medicolegal_flags: z.array(z.enum(MEDICOLEGAL_FLAGS)).optional(),
  findings: z.record(z.string(), z.unknown()).optional(),
  is_synthetic: z.boolean().optional(),
})

export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, "death", "view", "clinical")
  if (cap) return cap
  const encounterId = req.nextUrl.searchParams.get("encounter_id")
  const patientId = req.nextUrl.searchParams.get("patient_id")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db.from("death_pronouncements").select("*").eq("tenant_id", ctx.tenantId).order("pronounced_at", { ascending: false }).limit(50)
  if (encounterId) query = query.eq("encounter_id", encounterId)
  if (patientId) query = query.eq("patient_id", patientId)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ pronouncements: (data ?? []).map((row: Record<string, unknown>) => deathPronouncementFromRow(row)) })
}

export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, "death", "pronounce", "clinical")
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, "clinical")
  if (moduleBlock) return moduleBlock

  try {
    assertCanPronounce(true)
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: patient } = await db.from("patients").select("id, person_id, full_name, display_name").eq("id", parsed.data.patient_id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!patient) return NextResponse.json({ error: "Patient not found" }, { status: 404 })
  const { data: encounter } = await db.from("encounters").select("id, patient_id, disposition").eq("id", parsed.data.encounter_id).eq("tenant_id", ctx.tenantId).maybeSingle()
  if (!encounter || encounter.patient_id !== parsed.data.patient_id) {
    return NextResponse.json({ error: "Encounter not found for patient" }, { status: 404 })
  }

  let record
  try {
    record = createDeathPronouncement({
      tenantId: ctx.tenantId,
      facilityId: ctx.hospitalId,
      patientId: parsed.data.patient_id,
      personId: parsed.data.person_id ?? patient.person_id ?? null,
      encounterId: parsed.data.encounter_id,
      deathTimePrecision: parsed.data.death_time_precision,
      deathDateTime: parsed.data.death_date_time ?? null,
      deathTimeText: parsed.data.death_time_text ?? null,
      pronouncedBy: ctx.userId,
      locationType: parsed.data.location_type,
      wardId: parsed.data.ward_id ?? null,
      bedId: parsed.data.bed_id ?? null,
      locationText: parsed.data.location_text ?? null,
      resuscitationAttempted: parsed.data.resuscitation_attempted,
      resuscitationStartedAt: parsed.data.resuscitation_started_at ?? null,
      resuscitationStoppedAt: parsed.data.resuscitation_stopped_at ?? null,
      dnrStatus: parsed.data.dnr_status ?? null,
      circumstances: parsed.data.circumstances ?? null,
      provisionalCause: parsed.data.provisional_cause ?? null,
      contributingConditions: parsed.data.contributing_conditions ?? null,
      externalCauseSuspected: parsed.data.external_cause_suspected,
      traumaticDeath: parsed.data.traumatic_death,
      suspiciousDeath: parsed.data.suspicious_death,
      medicolegalFlags: parsed.data.medicolegal_flags,
      findings: parsed.data.findings as never,
      isSynthetic: parsed.data.is_synthetic,
    })
    assertSameDeathTenant(record, ctx.tenantId)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid pronouncement"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const display = String(patient.full_name ?? patient.display_name ?? "Patient")
  const document = signClinicalDocument(
    createClinicalDocument({
      tenantId: ctx.tenantId,
      facilityId: ctx.hospitalId,
      patientId: record.patientId,
      personId: record.personId,
      encounterId: record.encounterId,
      authorId: ctx.userId,
      documentType: CLINICAL_DOCUMENT_TYPES.find((type) => type === "DEATH_PRONOUNCEMENT") ?? "DEATH_PRONOUNCEMENT",
      templateId: "death.pronouncement.v1",
      templateVersion: "v1",
      countryPack: "UG",
      structuredPayload: { pronouncementId: record.id, precision: record.deathTimePrecision },
      renderedSnapshot: renderPronouncementSnapshot(record, display),
    }),
    { signedBy: ctx.userId },
  )
  assertDocumentTenant(document, ctx.tenantId)
  record.pronouncementDocumentId = document.id

  const { error: docError } = await db.from("clinical_documents").insert(clinicalDocumentToRow(document))
  if (docError) return NextResponse.json({ error: docError.message }, { status: 500 })
  const { error } = await db.from("death_pronouncements").insert(deathPronouncementToRow(record))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const deceased = deceasedDisposition(record.id)
  await db.from("encounters").update({
    disposition: deceased.disposition,
    death_pronouncement_id: record.id,
    disposition_by: ctx.userId,
    disposition_at: record.pronouncedAt,
    updated_at: record.updatedAt,
  }).eq("id", record.encounterId).eq("tenant_id", ctx.tenantId)

  await logHospitalAudit({
    ctx,
    action: "INSERT",
    tableName: "death_pronouncements",
    recordId: record.id,
    newValue: { status: record.status, precision: record.deathTimePrecision },
  })
  void publishClinicalTimelineBestEffort(
    publishTimelineEvent,
    deathPronouncedTimelineEvent({
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      patientId: record.patientId,
      encounterId: record.encounterId,
      pronouncementId: record.id,
      precision: record.deathTimePrecision,
      createdBy: ctx.userId,
    }),
  )
  return NextResponse.json({ pronouncement: record, document }, { status: 201 })
}
