import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { recordAdmissionPlaced } from '@synapse/db/clinical-journey'
import { persistWorkQueueArtifactsBestEffort } from '@synapse/db/work-queue-persist'
import { admissionTimelineEvent, publishClinicalTimelineBestEffort } from '@synapse/db/clinical-timeline'
import { publishTimelineEvent } from '@synapse/db/identity-persist'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '../../../../lib/hospital-shared'
import {
  requireHospitalStaffContext,
  requireTenantPatient,
  requireHospitalEncounter,
  admissionCreateSchema,
  isMissingRpc,
  rpcDomainError,
} from '../../../../lib/hospital-dept'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'admission', 'read', 'ipd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'ipd')
  if (moduleBlock) return moduleBlock

  const availableOnly = req.nextUrl.searchParams.get('available') === 'true'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let bedQuery = db
    .from('hospital_beds')
    .select('id, ward, room, bed_number, status, current_patient_id, bed_type')
    .eq('hospital_id', ctx.hospitalId)
    .eq('is_deleted', false)
    .order('ward')
    .limit(200)

  if (ctx.tenantId) bedQuery = bedQuery.eq('tenant_id', ctx.tenantId)
  if (availableOnly) bedQuery = bedQuery.is('current_patient_id', null).eq('status', 'available')

  const { data: beds, error: bedError } = await bedQuery
  if (bedError) return NextResponse.json({ error: bedError.message }, { status: 500 })

  const [{ data: tasks }, inpatients] = await Promise.all([
    db
      .from('department_tasks')
      .select('id, patient_id, encounter_id, title, status, source_id, created_at')
      .eq('tenant_id', ctx.tenantId)
      .eq('task_type', 'admission')
      .order('created_at', { ascending: false })
      .limit(50),
    db
      .from('hospital_admissions')
      .select('id, patient_id, encounter_id, bed_id, ward, reason, admitted_at, patients(full_name, mrn), hospital_beds(bed_number)')
      .eq('tenant_id', ctx.tenantId)
      .eq('hospital_id', ctx.hospitalId)
      .eq('status', 'admitted')
      .order('admitted_at', { ascending: false })
      .limit(200),
  ])

  // hospital_admissions arrives with 20261120140000; until then the list is empty.
  const current = inpatients.error ? [] : ((inpatients.data ?? []) as Array<Record<string, unknown>>)
  return NextResponse.json({
    beds: beds ?? [],
    admissions: tasks ?? [],
    inpatients: current.map((a) => {
      const patient = a.patients as { full_name?: string; mrn?: string } | null
      const bed = a.hospital_beds as { bed_number?: string } | null
      return {
        id: a.id,
        patientId: a.patient_id,
        patientName: patient?.full_name ?? null,
        mrn: patient?.mrn ?? null,
        encounterId: a.encounter_id,
        bedId: a.bed_id,
        bedNumber: bed?.bed_number ?? null,
        ward: a.ward,
        reason: a.reason,
        admittedAt: a.admitted_at,
      }
    }),
  })
}

export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'admission', 'create', 'ipd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'ipd')
  if (moduleBlock) return moduleBlock

  const body = await req.json().catch(() => null)
  const parsed = admissionCreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { patient_id, bed_id, reason, encounter_id } = parsed.data

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Authoritative write: one transaction checks patient, encounter and bed
  // (row-locked), records the admission and occupies the bed, so two clerks
  // cannot put two patients in one bed.
  const newAdmissionId = crypto.randomUUID()
  const { data: admitted, error: admitError } = await db.rpc('hospital_admit_patient', {
    p_tenant_id: ctx.tenantId,
    p_hospital_id: ctx.hospitalId,
    p_patient_id: patient_id,
    p_bed_id: bed_id,
    p_actor_id: ctx.userId,
    p_reason: reason,
    p_encounter_id: encounter_id ?? null,
    p_admission_id: newAdmissionId,
  })
  if (admitError && !isMissingRpc(admitError)) {
    const mapped = rpcDomainError(admitError)
    if (mapped.status === 500) console.error('[ipd/admissions] admit failed', admitError.code, admitError.message)
    return NextResponse.json({ error: mapped.code }, { status: mapped.status })
  }
  if (!admitError) {
    return finishAdmission(db, ctx, {
      admissionId: newAdmissionId,
      patient_id,
      bed_id,
      reason,
      encounter_id: encounter_id ?? null,
      ward: (admitted?.ward as string | null) ?? null,
    })
  }

  // Pre-migration path.
  const patientBlock = await requireTenantPatient(db, ctx.tenantId, patient_id)
  if (patientBlock) return patientBlock
  if (encounter_id) {
    const encounterBlock = await requireHospitalEncounter(db, ctx.hospitalId, encounter_id, patient_id)
    if (encounterBlock) return encounterBlock
  }

  const { data: bed, error: bedError } = await db
    .from('hospital_beds')
    .select('id, ward, status, current_patient_id, hospital_id, tenant_id')
    .eq('id', bed_id)
    .eq('hospital_id', ctx.hospitalId)
    .maybeSingle()

  if (bedError) return NextResponse.json({ error: bedError.message }, { status: 500 })
  if (!bed) return NextResponse.json({ error: 'Bed not found' }, { status: 404 })
  if (bed.current_patient_id) {
    return NextResponse.json({ error: 'Bed is already occupied' }, { status: 409 })
  }

  let journeyWarnings: string[] = []
  let admissionId = crypto.randomUUID()
  let admissionTaskId: string | undefined
  let correlationId = encounter_id ?? admissionId

  try {
    const journey = recordAdmissionPlaced({
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      patientId: patient_id,
      bedId: bed_id,
      requesterId: ctx.userId,
      reason,
      encounterId: encounter_id ?? null,
      ward: bed.ward ?? null,
      admissionId,
      correlationId: encounter_id ?? admissionId,
    })

    admissionId = journey.admissionId
    admissionTaskId = journey.admissionTask.id
    correlationId = journey.correlationId

    const { error: bedUpdateError } = await db
      .from('hospital_beds')
      .update({
        current_patient_id: patient_id,
        status: 'occupied',
        last_status_change: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', bed_id)
      .is('current_patient_id', null)

    if (bedUpdateError) journeyWarnings.push(bedUpdateError.message)

    const persistQueue = await persistWorkQueueArtifactsBestEffort(db, {
      tasks: [journey.admissionTask],
      events: journey.queue.outbox.list({ correlationId: journey.correlationId }),
    })
    if (persistQueue.errors.length) journeyWarnings.push(...persistQueue.errors)
    void publishClinicalTimelineBestEffort(
      publishTimelineEvent,
      admissionTimelineEvent({
        tenantId: ctx.tenantId,
        hospitalId: ctx.hospitalId,
        patientId: patient_id,
        admissionId,
        bedId: bed_id,
        ward: bed.ward ?? null,
        reason,
        createdBy: ctx.userId,
      }),
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Admission journey failed' },
      { status: 500 },
    )
  }

  await logHospitalAudit({
    ctx,
    action: 'UPDATE',
    tableName: 'hospital_beds',
    recordId: bed_id,
    newValue: { patient_id, admission_id: admissionId, reason },
  })

  const response: {
    admissionId: string
    admissionTaskId?: string
    bedId: string
    correlationId: string
    journeyWarnings?: string[]
  } = {
    admissionId,
    bedId: bed_id,
    correlationId,
  }
  if (admissionTaskId) response.admissionTaskId = admissionTaskId
  if (journeyWarnings.length) response.journeyWarnings = journeyWarnings

  return NextResponse.json(response, { status: 201 })
}

/** Work queue, timeline and audit after the admission is committed. Best effort: the admission stands. */
async function finishAdmission(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ctx: Exclude<Awaited<ReturnType<typeof requireHospitalStaffContext>>, NextResponse>,
  input: { admissionId: string; patient_id: string; bed_id: string; reason: string; encounter_id: string | null; ward: string | null },
) {
  const journeyWarnings: string[] = []
  let admissionTaskId: string | undefined
  let correlationId = input.encounter_id ?? input.admissionId
  try {
    const journey = recordAdmissionPlaced({
      tenantId: ctx.tenantId,
      hospitalId: ctx.hospitalId,
      patientId: input.patient_id,
      bedId: input.bed_id,
      requesterId: ctx.userId,
      reason: input.reason,
      encounterId: input.encounter_id,
      ward: input.ward,
      admissionId: input.admissionId,
      correlationId,
    })
    admissionTaskId = journey.admissionTask.id
    correlationId = journey.correlationId
    const persistQueue = await persistWorkQueueArtifactsBestEffort(db, {
      tasks: [journey.admissionTask],
      events: journey.queue.outbox.list({ correlationId: journey.correlationId }),
    })
    if (persistQueue.errors.length) journeyWarnings.push(...persistQueue.errors)
    void publishClinicalTimelineBestEffort(
      publishTimelineEvent,
      admissionTimelineEvent({
        tenantId: ctx.tenantId,
        hospitalId: ctx.hospitalId,
        patientId: input.patient_id,
        admissionId: input.admissionId,
        bedId: input.bed_id,
        ward: input.ward,
        reason: input.reason,
        createdBy: ctx.userId,
      }),
    )
  } catch (error) {
    journeyWarnings.push(error instanceof Error ? error.message : 'admission journey failed')
  }

  await logHospitalAudit({
    ctx,
    action: 'INSERT',
    tableName: 'hospital_admissions',
    recordId: input.admissionId,
    newValue: { patient_id: input.patient_id, bed_id: input.bed_id, reason: input.reason },
  })

  return NextResponse.json(
    {
      admissionId: input.admissionId,
      bedId: input.bed_id,
      correlationId,
      ...(admissionTaskId ? { admissionTaskId } : {}),
      ...(journeyWarnings.length ? { journeyWarnings } : {}),
    },
    { status: 201 },
  )
}
