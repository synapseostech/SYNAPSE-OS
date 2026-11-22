import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { callsOf, dbMock, type Result } from '../../../../lib/lab/testing/db-mock'

const state = vi.hoisted(() => ({
  db: null as unknown as { from: unknown; rpc: unknown },
  denied: new Set<string>(),
  asked: [] as string[],
  audit: vi.fn(),
  charge: vi.fn(async () => ({ ok: true, result: { created: true } })),
  price: 25000 as number | null,
}))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a), rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@synapse/db/clinical-charge', () => ({ resolveServicePrice: async () => state.price, appendClinicalChargeBestEffort: state.charge }))
vi.mock('@/lib/hospital-dept', () => ({ requireHospitalStaffContext: async () => ({ userId: 'u-1', tenantId: 'tenant-a', hospitalId: 'hosp-a', role: 'doctor', email: 'd@x', facilityType: 'hospital', fullName: 'Dr Demo' }) }))
vi.mock('@/lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: async (_c: unknown, resource: string, action: string, module: string) => {
    const key = `${module}.${resource}.${action}`
    state.asked.push(key)
    return state.denied.has(key) ? NextResponse.json({ error: 'Forbidden' }, { status: 403 }) : null
  },
  gateHospitalModule: async () => null,
  logHospitalAudit: state.audit,
}))

import { GET as listForEncounter, POST as createOrder } from './orders/route'
import { GET as worklist } from './worklist/route'
import { POST as act } from './studies/[id]/route'
import { GET as printReport } from './studies/[id]/report/route'

const ENC = '11111111-1111-4111-8111-111111111111'
const STUDY = '22222222-2222-4222-8222-222222222222'
const json = (url: string, body: unknown) => new NextRequest(url, { method: 'POST', body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { vi.clearAllMocks(); state.denied = new Set(); state.asked = []; state.price = 25000 })

describe('POST /api/hospital/radiology/orders', () => {
  function seed(existing: unknown = null) {
    let studyCalls = 0
    const m = dbMock({
      rpc: () => ({ data: 'RAD-20261122-000001' }),
      tables: {
        encounters: { data: { id: ENC, patient_id: 'pat-1', is_signed: false } },
        imaging_studies: () => (studyCalls++ === 0 ? { data: existing } : { data: { id: STUDY, accession_number: 'RAD-20261122-000001', worklist_status: 'pending' } }) as Result,
      },
    })
    state.db = m.db
    return m
  }

  it('creates a scoped request with an accession and bills it once', async () => {
    const m = seed()
    const res = await createOrder(json('http://x', { encounter_id: ENC, exam_code: 'cxr', clinical_indication: 'Cough 3 weeks, ?PTB', priority: 'urgent' }))
    expect(res.status).toBe(201)
    expect(state.asked).toContain('radiology.order.create')
    expect(callsOf(m.tableCalls.encounters![0], 'eq')).toEqual(expect.arrayContaining([['tenant_id', 'tenant-a'], ['hospital_id', 'hosp-a']]))
    const insert = callsOf(m.tableCalls.imaging_studies![1], 'insert')[0]![0] as Record<string, unknown>
    expect(insert).toMatchObject({ tenant_id: 'tenant-a', hospital_id: 'hosp-a', patient_id: 'pat-1', modality: 'XR', body_part: 'chest', accession_number: 'RAD-20261122-000001', priority: 'urgent', is_urgent: true, worklist_status: 'pending', study_description: 'Chest X-ray' })
    expect(state.charge).toHaveBeenCalledTimes(1)
    expect(state.charge.mock.calls[0]![1]).toMatchObject({ itemName: 'Imaging · Chest X-ray', unitPrice: 25000, sourceTable: 'imaging_studies' })
  })

  it('is idempotent per exam per visit and does not bill twice', async () => {
    seed({ id: STUDY, worklist_status: 'pending' })
    const res = await createOrder(json('http://x', { encounter_id: ENC, exam_code: 'CXR', clinical_indication: 'Cough' }))
    expect(res.status).toBe(200)
    expect((await res.json()).idempotent).toBe(true)
    expect(state.charge).not.toHaveBeenCalled()
  })

  it('refuses an unknown exam, a sided exam without a side, and an unpriced exam is created with a warning', async () => {
    seed()
    expect((await createOrder(json('http://x', { encounter_id: ENC, exam_code: 'XYZ', clinical_indication: 'x x x' }))).status).toBe(400)
    expect((await createOrder(json('http://x', { encounter_id: ENC, exam_code: 'LIMB_XR', clinical_indication: 'Fall, pain' }))).status).toBe(400)
    seed()
    state.price = null
    const res = await createOrder(json('http://x', { encounter_id: ENC, exam_code: 'ABD_US', clinical_indication: 'RUQ pain' }))
    expect(res.status).toBe(201)
    expect((await res.json()).warnings[0]).toMatch(/SERVICE_PRICE_NOT_CONFIGURED/)
  })

  it('needs radiology.order.create', async () => {
    state.denied.add('radiology.order.create')
    seed()
    expect((await createOrder(json('http://x', { encounter_id: ENC, exam_code: 'CXR', clinical_indication: 'Cough' }))).status).toBe(403)
  })

  it('shows the clinician only verified reports', async () => {
    state.db = dbMock({ tables: { imaging_studies: { data: [
      { id: 'a', worklist_status: 'reported', radiology_reports: [{ findings: 'draft' }] },
      { id: 'b', worklist_status: 'verified', radiology_reports: [{ findings: 'final' }] },
    ] } } }).db
    const body = await (await listForEncounter(new NextRequest(`http://x?encounter_id=${ENC}`))).json()
    expect(body.studies.find((s: { id: string }) => s.id === 'a').radiology_reports).toEqual([])
    expect(body.studies.find((s: { id: string }) => s.id === 'b').radiology_reports[0].findings).toBe('final')
  })
})

describe('GET /api/hospital/radiology/worklist', () => {
  it('is scoped, puts STAT first and needs radiology.order.read', async () => {
    const m = dbMock({ tables: { imaging_studies: { data: [
      { id: 'r', priority: 'routine', created_at: '2026-11-22T07:00:00Z' },
      { id: 's', priority: 'stat', created_at: '2026-11-22T09:00:00Z' },
    ] } } })
    state.db = m.db
    const body = await (await worklist(new NextRequest('http://x?view=open'))).json()
    expect(body.studies.map((s: { id: string }) => s.id)).toEqual(['s', 'r'])
    expect(callsOf(m.tableCalls.imaging_studies![0], 'eq')).toEqual(expect.arrayContaining([['tenant_id', 'tenant-a'], ['hospital_id', 'hosp-a']]))
    expect(state.asked).toContain('radiology.order.read')
    expect((await worklist(new NextRequest('http://x?view=bogus'))).status).toBe(400)
  })
})

describe('POST /api/hospital/radiology/studies/[id]', () => {
  function seed(status: string, report: unknown = null, moved: unknown[] = [{ id: STUDY }]) {
    let studyCalls = 0
    const m = dbMock({
      tables: {
        imaging_studies: () => (studyCalls++ === 0 ? { data: { id: STUDY, encounter_id: ENC, patient_id: 'pat-1', modality: 'XR', body_part: 'chest', worklist_status: status, metadata: {} } } : { data: moved }) as Result,
        radiology_reports: (() => { let n = 0; return () => (n++ === 0 ? { data: report } : { data: { id: 'rep-new' } }) as Result })(),
      },
    })
    state.db = m.db
    return m
  }

  it('start needs report.write and moves pending -> in_progress, guarded by the old status', async () => {
    const m = seed('pending')
    const res = await act(json('http://x', { action: 'start' }), params(STUDY))
    expect(res.status).toBe(200)
    expect(state.asked).toContain('radiology.report.write')
    expect(callsOf(m.tableCalls.imaging_studies![1], 'eq')).toEqual(expect.arrayContaining([['worklist_status', 'pending'], ['tenant_id', 'tenant-a']]))
  })

  it('report writes a preliminary draft; verify needs report.verify and signs it final', async () => {
    let m = seed('in_progress')
    let res = await act(json('http://x', { action: 'report', findings: 'Right lower lobe consolidation', impression: 'Pneumonia', is_critical: false }), params(STUDY))
    expect(res.status).toBe(200)
    const ins = callsOf(m.tableCalls.radiology_reports![1], 'insert')[0]![0] as Record<string, unknown>
    expect(ins).toMatchObject({ status: 'preliminary', radiographer_id: 'u-1', tenant_id: 'tenant-a', study_id: STUDY, encounter_id: ENC })

    m = seed('reported', { id: 'rep-1', findings: 'Right lower lobe consolidation', impression: 'Pneumonia', radiographer_id: 'u-0' })
    res = await act(json('http://x', { action: 'verify' }), params(STUDY))
    expect(res.status).toBe(200)
    expect(state.asked).toContain('radiology.report.verify')
    const up = callsOf(m.tableCalls.radiology_reports![1], 'update')[0]![0] as Record<string, unknown>
    expect(up).toMatchObject({ status: 'final', radiologist_id: 'u-1' })
  })

  it('refuses out-of-order steps, empty reports and a verify with no report', async () => {
    seed('pending')
    expect((await act(json('http://x', { action: 'verify' }), params(STUDY))).status).toBe(409)
    seed('in_progress')
    expect((await act(json('http://x', { action: 'report', findings: '', impression: 'x' }), params(STUDY))).status).toBe(400)
    seed('reported', null)
    expect((await act(json('http://x', { action: 'verify' }), params(STUDY))).status).toBe(409)
  })

  it('answers 409 when someone else moved the study first', async () => {
    seed('pending', null, [])
    const res = await act(json('http://x', { action: 'start' }), params(STUDY))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RADIOLOGY_STALE')
  })

  it('a radiographer without verify capability cannot sign', async () => {
    state.denied.add('radiology.report.verify')
    seed('reported', { id: 'rep-1', findings: 'x x x', impression: 'y y y' })
    expect((await act(json('http://x', { action: 'verify' }), params(STUDY))).status).toBe(403)
  })
})

describe('GET /api/hospital/radiology/studies/[id]/report', () => {
  const study = (status: string) => ({
    id: STUDY, accession_number: 'RAD-1', modality: 'XR', body_part: 'chest', study_description: 'Chest X-ray', clinical_indication: 'Cough', worklist_status: status, created_at: '2026-11-22T08:00:00Z',
    patients: { full_name: 'Demo Patient', mrn: 'M-1', sex: 'F', dob: '1990-01-01' },
    radiology_reports: [{ findings: 'Clear lungs', impression: 'Normal chest', is_critical: false, radiographer_id: 'u-0', radiologist_id: 'u-9' }],
  })

  it('a clinician cannot see a draft; imaging staff see it marked preliminary', async () => {
    state.denied.add('radiology.order.read')
    state.db = dbMock({ tables: { imaging_studies: { data: study('reported') }, profiles: { data: [] }, hospitals: { data: { name: 'Demo Hospital' } } } }).db
    expect((await printReport(new NextRequest('http://x'), params(STUDY))).status).toBe(404)
    state.denied = new Set()
    state.db = dbMock({ tables: { imaging_studies: { data: study('reported') }, profiles: { data: [] }, hospitals: { data: { name: 'Demo Hospital' } } } }).db
    const html = await (await printReport(new NextRequest('http://x'), params(STUDY))).text()
    expect(html).toContain('PRELIMINARY')
  })

  it('prints a verified report with the radiologist and a no-script CSP', async () => {
    state.denied.add('radiology.order.read')
    state.db = dbMock({ tables: { imaging_studies: { data: study('verified') }, profiles: { data: [{ id: 'u-9', full_name: 'Dr Demo Radiologist' }] }, hospitals: { data: { name: 'Demo Hospital' } } } }).db
    const res = await printReport(new NextRequest('http://x'), params(STUDY))
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain('Dr Demo Radiologist')
    expect(html).toContain('Demo Hospital')
    expect(html).not.toContain('PRELIMINARY')
  })
})
