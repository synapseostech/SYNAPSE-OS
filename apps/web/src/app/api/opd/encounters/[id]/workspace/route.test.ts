import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMemoryDb } from '../../../../../../test-utils/memory-postgrest'

const state = vi.hoisted(() => ({ db: null as any, cap: null as Response | null }))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: { from: (table: string) => state.db.from(table) },
}))
vi.mock('@/lib/hospital-dept', () => ({
  requireHospitalStaffContext: async () => ({
    userId: '00000000-0000-4000-8000-0000000000c1',
    tenantId: 'tenant-a',
    hospitalId: 'hosp-a',
    role: 'doctor',
  }),
}))
vi.mock('@/lib/hospital-shared', () => ({
  isContextError: (value: unknown) => value instanceof NextResponse,
  requireHospitalCapability: async () => state.cap,
  gateHospitalModule: async () => null,
}))

import { GET } from './route'

const call = (id: string) => GET(new Request('http://localhost/api'), { params: Promise.resolve({ id }) })

function seed() {
  state.cap = null
  state.db = createMemoryDb({
    encounters: [
      { id: 'enc-today', tenant_id: 'tenant-a', patient_id: 'pat-1', is_deleted: false, chief_complaint: 'Cough', visit_date: '2026-11-20T08:00:00Z', metadata: { consultation: { findings: { cough: 'present' } } }, status: 'in_progress', is_signed: false },
      { id: 'enc-last', tenant_id: 'tenant-a', patient_id: 'pat-1', is_deleted: false, chief_complaint: 'Fever', visit_date: '2026-11-10T08:00:00Z', metadata: { writeup: { plan: 'Review in 1 week' } } },
      { id: 'enc-other-tenant', tenant_id: 'tenant-b', patient_id: 'pat-1', is_deleted: false, chief_complaint: 'Secret', visit_date: '2026-11-15T08:00:00Z', metadata: {} },
      { id: 'enc-b-only', tenant_id: 'tenant-b', patient_id: 'pat-9', is_deleted: false, chief_complaint: 'Other', visit_date: '2026-11-15T08:00:00Z', metadata: {} },
    ],
    patients: [
      { id: 'pat-1', tenant_id: 'tenant-a', full_name: 'Demo Patient', mrn: 'MRN-1', sex: 'F', dob: '1990-01-01', chronic_conditions: [], allergies: [] },
      { id: 'pat-9', tenant_id: 'tenant-b', full_name: 'Other Patient', mrn: 'B-9', sex: 'M', dob: '1980-01-01' },
    ],
    patient_allergies: [
      { patient_id: 'pat-1', tenant_id: 'tenant-a', allergen: 'Penicillin', is_active: true, is_deleted: false },
      { patient_id: 'pat-1', tenant_id: 'tenant-b', allergen: 'Leaked allergy', is_active: true, is_deleted: false },
    ],
    lab_test_catalog: [
      { id: 'c1', tenant_id: 'tenant-a', code: 'MRDT', loinc_code: '58413-6', name: 'Malaria RDT', section: 'parasitology', is_active: true },
      { id: 'c2', tenant_id: 'tenant-b', code: 'X', loinc_code: '1-1', name: 'Other lab test', section: 'general', is_active: true },
    ],
    encounter_diagnoses: [
      { encounter_id: 'enc-last', tenant_id: 'tenant-a', stem_code: '1F40.Z', title: 'Malaria due to Plasmodium falciparum, unspecified', certainty: 'confirmed', is_deleted: false },
    ],
    clinical_prescriptions: [],
    vitals: [
      { encounter_id: 'enc-last', tenant_id: 'tenant-a', recorded_at: '2026-11-10T08:05:00Z', bp_systolic: 130, is_deleted: false },
      { encounter_id: 'enc-today', tenant_id: 'tenant-a', recorded_at: '2026-11-20T08:05:00Z', bp_systolic: 150, temperature_c: 38.4, is_deleted: false },
    ],
    lab_results: [],
    imaging_studies: [
      { id: 'img-draft', tenant_id: 'tenant-a', encounter_id: 'enc-today', is_deleted: false, study_description: 'Chest X-ray', modality: 'XR', priority: 'routine', worklist_status: 'reported', metadata: { exam_code: 'CXR' }, created_at: '2026-11-20T08:30:00Z', radiology_reports: [{ impression: 'DRAFT-IMPRESSION' }] },
      { id: 'img-final', tenant_id: 'tenant-a', encounter_id: 'enc-today', is_deleted: false, study_description: 'Abdominal ultrasound', modality: 'US', priority: 'routine', worklist_status: 'verified', metadata: { exam_code: 'ABD_US' }, created_at: '2026-11-20T08:20:00Z', radiology_reports: [{ impression: 'Normal abdomen' }] },
      { id: 'img-other', tenant_id: 'tenant-b', encounter_id: 'enc-today', is_deleted: false, study_description: 'Leak', modality: 'XR', priority: 'routine', worklist_status: 'verified', metadata: {}, created_at: '2026-11-20T08:10:00Z', radiology_reports: [] },
    ],
    lab_orders: [
      { id: 'o1', encounter_id: 'enc-today', tenant_id: 'tenant-a', test_name: 'Malaria RDT', loinc_code: '58413-6', workflow_status: 'ordered', ordered_at: '2026-11-20T08:10:00Z' },
    ],
  })
}

describe('consultation workspace', () => {
  beforeEach(seed)

  it('returns today, the last visit and the tenant catalogue', async () => {
    const res = await call('enc-today')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.encounter.chiefComplaint).toBe('Cough')
    expect(body.encounter.findings).toEqual({ cough: 'present' })
    expect(body.encounter.vitals.temperature_c).toBe(38.4)
    expect(body.encounter.labOrders.map((o: { id: string }) => o.id)).toEqual(['o1'])
    expect(body.summary.lastVisit.encounterId).toBe('enc-last')
    expect(body.summary.lastVisit.plan).toBe('Review in 1 week')
    expect(body.summary.lastVisit.diagnoses[0].code).toBe('1F40.Z')
    expect(body.labCatalog.map((c: { code: string }) => c.code)).toEqual(['MRDT'])
  })

  it('never mixes in another tenant’s visits, allergies or catalogue', async () => {
    const body = await (await call('enc-today')).json()
    expect(body.summary.visits.map((v: { encounterId: string }) => v.encounterId)).not.toContain('enc-other-tenant')
    expect(body.summary.allergies.map((a: { allergen: string }) => a.allergen)).toEqual(['Penicillin'])
    expect(JSON.stringify(body)).not.toContain('Secret')
    expect(JSON.stringify(body)).not.toContain('Leaked allergy')
  })

  it('lists this visit’s imaging, with report text only once verified', async () => {
    const body = await (await call('enc-today')).json()
    const ids = body.encounter.imaging.map((i: { id: string }) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['img-draft', 'img-final']))
    expect(ids).not.toContain('img-other')
    expect(JSON.stringify(body)).not.toContain('DRAFT-IMPRESSION')
    expect(body.encounter.imaging.find((i: { id: string }) => i.id === 'img-final').radiology_reports[0].impression).toBe('Normal abdomen')
  })

  it('answers 404 for another tenant’s encounter', async () => {
    expect((await call('enc-b-only')).status).toBe(404)
  })

  it('is refused without the capability', async () => {
    state.cap = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await call('enc-today')).status).toBe(403)
  })
})
