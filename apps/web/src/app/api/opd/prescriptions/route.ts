import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { recordPrescriptionPlaced } from '@synapse/db/clinical-journey'
import { persistClinicalPrescriptionBestEffort } from '@synapse/db/prescription-persist'
import { prescriptionTimelineEvent, publishClinicalTimelineBestEffort } from '@synapse/db/clinical-timeline'
import { publishTimelineEvent } from '@synapse/db/identity-persist'
import { persistWorkQueueArtifactsBestEffort } from '@synapse/db/work-queue-persist'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '@/lib/hospital-shared'
import { requireHospitalStaffContext, prescriptionCreateSchema } from '@/lib/hospital-dept'
import { runClinicalSafetyCheck } from '@/lib/clinical-safety'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'prescription', 'read', 'opd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const encounterId = req.nextUrl.searchParams.get('encounter_id')
  const status = req.nextUrl.searchParams.get('status')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db
    .from('clinical_prescriptions')
    .select(
      'id, tenant_id, pharmacy_tenant_id, patient_id, encounter_id, medication_display, dose, quantity, unit, status, prescriber_id, correlation_id, is_synthetic, created_at',
    )
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (encounterId) query = query.eq('encounter_id', encounterId)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ prescriptions: data ?? [] })
}

export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'prescription', 'create', 'opd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const body = await req.json().catch(() => null)
  const parsed = prescriptionCreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const {
    encounter_id,
    patient_id,
    medication_display,
    dose,
    quantity,
    unit,
    care_plan_id,
    person_id,
    pharmacy_tenant_id,
    safety_override_reason,
  } = parsed.data

  if (pharmacy_tenant_id && pharmacy_tenant_id !== ctx.tenantId) {
    return NextResponse.json({ error: 'Pharmacy not available to this facility' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: encounter, error: encounterError } = await db
    .from('encounters')
    .select('id, patient_id, tenant_id')
    .eq('id', encounter_id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (encounterError) return NextResponse.json({ error: encounterError.message }, { status: 500 })
  if (!encounter) return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })
  if (encounter.patient_id !== patient_id) {
    return NextResponse.json({ error: 'Patient does not match encounter' }, { status: 400 })
  }

  // Clinical safety runs before anything is written. A block means no
  // prescription row, no pharmacy task and no timeline event are created.
  const safety = await runClinicalSafetyCheck({
    db,
    tenantId: ctx.tenantId,
    hospitalId: ctx.hospitalId,
    patientId: patient_id,
    encounterId: encounter_id,
    actorId: ctx.userId,
    stage: 'prescribe',
    newDrugs: [{ label: medication_display, aliases: [], role: 'new' }],
    overrideReason: safety_override_reason ?? null,
  })

  if (safety.decision.decision === 'block') {
    const overridden = typeof safety_override_reason === 'string' && safety_override_reason.trim().length > 0
    if (!overridden) {
      return NextResponse.json(
        {
          error: 'clinical_safety_block',
          message:
            'This prescription was stopped by a clinical safety check. Supply safety_override_reason to proceed deliberately.',
          safety: safety.payload,
          safetyAuditRecordId: safety.auditRecordId ?? null,
        },
        { status: 409 },
      )
    }
  }

  let journeyWarnings: string[] = []
  let prescriptionId = crypto.randomUUID()
  let pharmacyTaskId: string | undefined
  let correlationId = encounter_id

  try {
    const journey = recordPrescriptionPlaced({
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      patientId: patient_id,
      personId: person_id ?? null,
      encounterId: encounter_id,
      carePlanId: care_plan_id ?? null,
      requesterId: ctx.userId,
      medicationDisplay: medication_display,
      dose,
      quantity,
      unit,
      pharmacyTenantId: pharmacy_tenant_id ?? null,
      prescriptionId,
      correlationId: encounter_id,
    })

    prescriptionId = journey.prescription.id
    pharmacyTaskId = journey.pharmacyTask.id
    correlationId = journey.correlationId

    const persistRx = await persistClinicalPrescriptionBestEffort(db, journey.prescription)
    const persistQueue = await persistWorkQueueArtifactsBestEffort(db, {
      tasks: [journey.pharmacyTask],
      events: journey.queue.outbox.list({ correlationId: journey.correlationId }),
    })

    if (!persistRx.ok) journeyWarnings.push(persistRx.error)
    if (persistQueue.errors.length) journeyWarnings.push(...persistQueue.errors)
    if (journeyWarnings.length) {
      console.warn('[opd/prescriptions] journey persist partial', journeyWarnings)
    }
    void publishClinicalTimelineBestEffort(
      publishTimelineEvent,
      prescriptionTimelineEvent({
        tenantId: ctx.tenantId,
        hospitalId: ctx.hospitalId,
        patientId: patient_id,
        prescriptionId,
        encounterId: encounter_id,
        medicationDisplay: medication_display,
        dose,
        createdBy: ctx.userId,
      }),
    )
  } catch (error) {
    console.warn('[opd/prescriptions] clinical journey step failed', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Prescription journey failed' },
      { status: 500 },
    )
  }

  await logHospitalAudit({
    ctx,
    action: 'INSERT',
    tableName: 'clinical_prescriptions',
    recordId: prescriptionId,
    newValue: { encounter_id, patient_id, medication_display, dose, quantity },
  })

  const response: {
    prescriptionId: string
    pharmacyTaskId?: string
    correlationId: string
    journeyWarnings?: string[]
    safety: typeof safety.payload
    safetyAuditRecordId?: string
    safetyAuditError?: string
  } = {
    prescriptionId,
    correlationId,
    safety: safety.payload,
  }
  if (pharmacyTaskId) response.pharmacyTaskId = pharmacyTaskId
  if (journeyWarnings.length) response.journeyWarnings = journeyWarnings
  if (safety.auditRecordId) response.safetyAuditRecordId = safety.auditRecordId
  if (safety.auditError) response.safetyAuditError = safety.auditError

  return NextResponse.json(response, { status: 201 })
}
