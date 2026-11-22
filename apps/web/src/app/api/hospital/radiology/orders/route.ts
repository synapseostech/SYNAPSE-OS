import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@synapse/db/admin'
import { imagingExam } from '@synapse/db/radiology'
import { allocateAccessionNumber } from '@synapse/db/lab-result-persist'
import { appendClinicalChargeBestEffort, resolveServicePrice } from '@synapse/db/clinical-charge'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  encounter_id: z.string().uuid(),
  exam_code: z.string().min(2).max(40),
  clinical_indication: z.string().trim().min(3).max(2000),
  priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
  laterality: z.enum(['left', 'right', 'bilateral']).optional(),
}).strict()

const STUDY_COLUMNS = 'id, encounter_id, patient_id, accession_number, modality, body_part, laterality, study_description, clinical_indication, priority, is_urgent, worklist_status, status, metadata, created_at, updated_at'

/** Request an imaging exam for an encounter. Billed once from service_catalog (radiology) when priced. */
export async function POST(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, 'order', 'create', 'radiology')
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'radiology')
  if (moduleBlock) return moduleBlock

  const parsed = createSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const exam = imagingExam(parsed.data.exam_code)
  if (!exam) return NextResponse.json({ error: 'Unknown exam' }, { status: 400 })
  if (exam.sided && !parsed.data.laterality) return NextResponse.json({ error: `Choose the side for ${exam.name}` }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: encounter, error: encError } = await db
    .from('encounters')
    .select('id, patient_id, is_signed')
    .eq('id', parsed.data.encounter_id)
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .maybeSingle()
  if (encError) return NextResponse.json({ error: 'Could not load the encounter' }, { status: 500 })
  if (!encounter) return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })

  // One open request per exam per visit.
  const { data: existing } = await db
    .from('imaging_studies')
    .select(STUDY_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .eq('encounter_id', encounter.id)
    .eq('is_deleted', false)
    .contains('metadata', { exam_code: exam.code })
    .limit(1)
    .maybeSingle()
  if (existing) return NextResponse.json({ study: existing, idempotent: true })

  const accession = await allocateAccessionNumber(db, ctx.tenantId, 'RAD')
  const { data: study, error } = await db
    .from('imaging_studies')
    .insert({
      tenant_id: ctx.tenantId,
      hospital_id: ctx.hospitalId,
      patient_id: encounter.patient_id,
      encounter_id: encounter.id,
      accession_number: accession,
      modality: exam.modality,
      body_part: exam.bodyPart,
      laterality: parsed.data.laterality ?? null,
      study_description: exam.name,
      clinical_indication: parsed.data.clinical_indication,
      priority: parsed.data.priority,
      is_urgent: parsed.data.priority !== 'routine',
      worklist_status: 'pending',
      status: 'processing',
      created_by: ctx.userId,
      metadata: { exam_code: exam.code, requested_by: ctx.userId, requested_role: ctx.role },
    })
    .select(STUDY_COLUMNS)
    .single()
  if (error) return NextResponse.json({ error: 'Could not create the imaging request' }, { status: 500 })

  const warnings: string[] = []
  const price = await resolveServicePrice(db, ctx.tenantId, 'radiology', exam.name)
  if (price == null) warnings.push(`SERVICE_PRICE_NOT_CONFIGURED:radiology:${exam.name}`)
  else {
    const charge = await appendClinicalChargeBestEffort(db, {
      tenantId: ctx.tenantId,
      patientId: encounter.patient_id,
      encounterId: encounter.id,
      itemName: `Imaging · ${exam.name}`,
      unitPrice: price,
      sourceTable: 'imaging_studies',
      sourceId: study.id,
      createdBy: ctx.userId,
    })
    if (!charge.ok) warnings.push(charge.error)
  }

  await logHospitalAudit({
    ctx,
    action: 'INSERT',
    tableName: 'imaging_studies',
    recordId: study.id,
    newValue: { exam: exam.code, priority: parsed.data.priority, patient_id: encounter.patient_id, encounter_id: encounter.id },
  })
  return NextResponse.json({ study, ...(warnings.length ? { warnings } : {}) }, { status: 201 })
}

/** Imaging requests and verified reports for an encounter (consultation screen). */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, 'encounter', 'create', 'opd')
  if (cap) return cap
  const encounterId = req.nextUrl.searchParams.get('encounter_id')
  if (!encounterId || !/^[0-9a-f-]{36}$/i.test(encounterId)) return NextResponse.json({ error: 'encounter_id is required' }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db
    .from('imaging_studies')
    .select(`${STUDY_COLUMNS}, radiology_reports(id, status, findings, impression, recommendation, is_critical, reported_at)`)
    .eq('tenant_id', ctx.tenantId)
    .eq('encounter_id', encounterId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: 'Could not load imaging' }, { status: 500 })
  // Only verified reports reach the clinician's screen.
  const studies = (data ?? []).map((s: { worklist_status: string; radiology_reports?: unknown[] }) => ({
    ...s,
    radiology_reports: s.worklist_status === 'verified' ? s.radiology_reports ?? [] : [],
  }))
  return NextResponse.json({ studies }, { headers: { 'Cache-Control': 'private, no-store' } })
}
