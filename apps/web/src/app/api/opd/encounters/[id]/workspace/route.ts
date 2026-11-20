import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { buildContinuitySummary } from '@synapse/db/patient-continuity'
import { writeupFromEncounterMetadata, writeupCompleteness } from '@synapse/db/clinical-writeup'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

const HISTORY_LIMIT = 20

/**
 * Everything the consultation screen needs in one round trip: this encounter
 * (write-up, findings, vitals, diagnoses, orders) and the patient's history
 * (last visit, recurring problems, trends), plus the tenant's lab catalogue so
 * suggested investigations can be ordered in one tap.
 *
 * Every query is filtered by the session tenant (service role, defence in depth).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'encounter', 'create', 'opd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const { id: encounterId } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const { data: encounter, error: encError } = await db
    .from('encounters')
    .select('id, patient_id, chief_complaint, metadata, status, is_signed, visit_date, created_at, disposition, clinician_id')
    .eq('id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('is_deleted', false)
    .maybeSingle()
  if (encError) return NextResponse.json({ error: 'Could not load the encounter' }, { status: 500 })
  if (!encounter) return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })

  const patientId = encounter.patient_id as string
  const [patientRes, encountersRes, allergiesRes, catalogRes] = await Promise.all([
    db
      .from('patients')
      .select('id, full_name, mrn, sex, dob, date_of_birth, is_pregnant, chronic_conditions, current_medications, allergies, blood_group, district')
      .eq('id', patientId)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle(),
    db
      .from('encounters')
      .select('id, visit_date, created_at, chief_complaint, metadata, disposition, disposition_reason, status, is_signed')
      .eq('patient_id', patientId)
      .eq('tenant_id', ctx.tenantId)
      .eq('is_deleted', false)
      .order('visit_date', { ascending: false, nullsFirst: false })
      .limit(HISTORY_LIMIT),
    db
      .from('patient_allergies')
      .select('allergen, reaction, severity')
      .eq('patient_id', patientId)
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .limit(50),
    db
      .from('lab_test_catalog')
      .select('id, code, loinc_code, name, section, price, currency, turnaround_minutes')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(500),
  ])
  if (patientRes.error || encountersRes.error) {
    return NextResponse.json({ error: 'Could not load the patient record' }, { status: 500 })
  }
  if (!patientRes.data) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  const encounters = (encountersRes.data ?? []) as Array<{ id: string }>
  const ids = [...new Set([encounterId, ...encounters.map((e) => e.id)])]

  const [dxRes, rxRes, vitalsRes, resultsRes, ordersRes] = await Promise.all([
    db
      .from('encounter_diagnoses')
      .select('encounter_id, stem_code, title, certainty, diagnosis_type, suggested_by, created_at')
      .in('encounter_id', ids)
      .eq('tenant_id', ctx.tenantId)
      .eq('is_deleted', false),
    db
      .from('clinical_prescriptions')
      .select('encounter_id, medication_display, dose, quantity, unit, status, created_at')
      .in('encounter_id', ids)
      .eq('tenant_id', ctx.tenantId)
      .limit(300),
    db
      .from('vitals')
      .select('encounter_id, recorded_at, bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, respiratory_rate, weight_kg, height_cm')
      .in('encounter_id', ids)
      .eq('tenant_id', ctx.tenantId)
      .eq('is_deleted', false)
      .order('recorded_at', { ascending: true })
      .limit(300),
    db
      .from('lab_results')
      .select('lab_order_id, encounter_id, test_name, loinc_code, value, result_value, numeric_value, unit, flag, abnormal_flag, is_abnormal, is_critical, status, verified_at, created_at')
      .eq('patient_id', patientId)
      .eq('tenant_id', ctx.tenantId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(300),
    db
      .from('lab_orders')
      .select('id, encounter_id, test_name, loinc_code, workflow_status, status, urgency, ordered_at, accession_number')
      .in('encounter_id', ids)
      .eq('tenant_id', ctx.tenantId)
      .order('ordered_at', { ascending: false })
      .limit(300),
  ])

  const diagnoses = dxRes.data ?? []
  const prescriptions = rxRes.data ?? []
  const vitals = vitalsRes.data ?? []
  const labResults = resultsRes.data ?? []
  const labOrders = ordersRes.data ?? []

  const summary = buildContinuitySummary({
    patient: patientRes.data,
    currentEncounterId: encounterId,
    encounters: encountersRes.data ?? [],
    diagnoses,
    prescriptions,
    vitals,
    labResults,
    labOrders,
    allergies: allergiesRes.data ?? [],
  })

  const meta = (encounter.metadata ?? {}) as Record<string, unknown>
  const writeup = writeupFromEncounterMetadata(encounter.metadata)
  const consultation = (meta.consultation ?? null) as { findings?: Record<string, string> } | null
  const todayVitals = vitals.filter((v: { encounter_id: string }) => v.encounter_id === encounterId)
  const latestVitals = todayVitals[todayVitals.length - 1] ?? null
  const resultsByOrder = new Map<string, unknown[]>()
  for (const r of labResults as Array<{ lab_order_id: string | null }>) {
    if (!r.lab_order_id) continue
    const list = resultsByOrder.get(r.lab_order_id) ?? []
    list.push(r)
    resultsByOrder.set(r.lab_order_id, list)
  }

  return NextResponse.json(
    {
      encounter: {
        id: encounter.id,
        patientId,
        chiefComplaint: encounter.chief_complaint,
        status: encounter.status,
        isSigned: Boolean(encounter.is_signed),
        visitDate: encounter.visit_date ?? encounter.created_at,
        disposition: encounter.disposition,
        writeup,
        completeness: writeupCompleteness(writeup),
        findings: consultation?.findings ?? {},
        vitals: latestVitals,
        diagnoses: diagnoses.filter((d: { encounter_id: string }) => d.encounter_id === encounterId),
        labOrders: labOrders
          .filter((o: { encounter_id: string }) => o.encounter_id === encounterId)
          .map((o: { id: string }) => ({ ...o, results: resultsByOrder.get(o.id) ?? [] })),
        prescriptions: prescriptions.filter((p: { encounter_id: string }) => p.encounter_id === encounterId),
      },
      summary,
      labCatalog: catalogRes.error ? [] : catalogRes.data ?? [],
    },
    { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' } },
  )
}
