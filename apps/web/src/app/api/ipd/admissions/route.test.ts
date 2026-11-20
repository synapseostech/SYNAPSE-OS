import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createDbMock, HOSPITAL_A, MISSING_RPC, staff, TENANT_A, USER } from '../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({
  db: null as never as ReturnType<typeof createDbMock>,
  ctx: null as unknown,
  cap: vi.fn(),
  mod: vi.fn(),
  audit: vi.fn(),
  persist: vi.fn(),
  patient: vi.fn(),
}))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: (...a: unknown[]) => h.cap(...a),
  gateHospitalModule: (...a: unknown[]) => h.mod(...a),
  logHospitalAudit: (...a: unknown[]) => h.audit(...a),
}))
vi.mock('../../../../lib/hospital-dept', async () => ({
  ...(await import('../../../../lib/hospital-dept/schemas')),
  ...(await import('../../../../lib/hospital-dept/rpc-errors')),
  requireHospitalStaffContext: async () => h.ctx,
  requireTenantPatient: (...a: unknown[]) => h.patient(...a),
  requireHospitalEncounter: async () => null,
}))
vi.mock('@synapse/db/clinical-journey', () => ({
  recordAdmissionPlaced: (input: { admissionId: string; correlationId: string }) => ({
    admissionId: input.admissionId,
    correlationId: input.correlationId,
    admissionTask: { id: 'task-adm' },
    queue: { outbox: { list: () => [] } },
  }),
}))
vi.mock('@synapse/db/work-queue-persist', () => ({
  persistWorkQueueArtifactsBestEffort: (...a: unknown[]) => h.persist(...a),
}))
vi.mock('@synapse/db/clinical-timeline', () => ({
  admissionTimelineEvent: (x: unknown) => x,
  publishClinicalTimelineBestEffort: vi.fn(),
}))
vi.mock('@synapse/db/identity-persist', () => ({ publishTimelineEvent: vi.fn() }))

const PATIENT = '33333333-3333-4333-8333-333333333333'
const BED = '44444444-4444-4444-8444-444444444444'
const admit = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST(new NextRequest('https://x.test/api/ipd/admissions', { method: 'POST', body: JSON.stringify(body) }))
}

beforeEach(() => {
  h.cap.mockResolvedValue(null)
  h.mod.mockResolvedValue(null)
  h.persist.mockResolvedValue({ errors: [] })
  h.patient.mockResolvedValue(null)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/ipd/admissions', () => {
  it('requires ipd.admission.create', async () => {
    h.ctx = staff('nurse')
    h.db = createDbMock({})
    h.cap.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await admit({ patient_id: PATIENT, bed_id: BED, reason: 'Malaria' })).status).toBe(403)
    expect(h.cap).toHaveBeenCalledWith(expect.anything(), 'admission', 'create', 'ipd')
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it('admits in one transaction and then queues the admission task', async () => {
    h.ctx = staff('clinical_officer', TENANT_A)
    h.db = createDbMock({})
    h.db.setRpc('hospital_admit_patient', { data: { ward: 'Male ward' }, error: null })
    const res = await admit({ patient_id: PATIENT, bed_id: BED, reason: 'Severe malaria' })
    expect(res.status).toBe(201)
    const [rpc] = h.db.rpcCalls
    expect(rpc.fn).toBe('hospital_admit_patient')
    expect(rpc.args).toMatchObject({
      p_tenant_id: TENANT_A, p_hospital_id: HOSPITAL_A, p_patient_id: PATIENT, p_bed_id: BED, p_actor_id: USER,
      p_reason: 'Severe malaria', p_encounter_id: null,
    })
    const body = await res.json()
    expect(body.admissionId).toBe(rpc.args.p_admission_id)
    expect(body.admissionTaskId).toBe('task-adm')
    expect(h.patient).not.toHaveBeenCalled()
    expect(h.db.calls).toHaveLength(0)
    expect(h.persist).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['BED_OCCUPIED', 409],
    ['ALREADY_ADMITTED', 409],
    ['PATIENT_NOT_FOUND', 404],
    ['BED_NOT_FOUND', 404],
  ])('returns %s as %i and queues nothing', async (code, status) => {
    h.ctx = staff('doctor')
    h.db = createDbMock({})
    h.db.setRpc('hospital_admit_patient', { data: null, error: { code: 'P0001', message: code } })
    const res = await admit({ patient_id: PATIENT, bed_id: BED, reason: 'x' })
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(code)
    expect(h.persist).not.toHaveBeenCalled()
  })

  it('keeps the pre-migration path working', async () => {
    h.ctx = staff('doctor', TENANT_A)
    h.db = createDbMock({
      hospital_beds: [
        { data: { id: BED, ward: 'W', status: 'available', current_patient_id: null, hospital_id: HOSPITAL_A, tenant_id: TENANT_A }, error: null },
        { data: null, error: null },
      ],
    })
    h.db.setRpc('hospital_admit_patient', MISSING_RPC)
    const res = await admit({ patient_id: PATIENT, bed_id: BED, reason: 'x' })
    expect(res.status).toBe(201)
    expect(h.patient).toHaveBeenCalledWith(expect.anything(), TENANT_A, PATIENT)
  })
})

describe('GET /api/ipd/admissions', () => {
  it('lists beds and current inpatients of the session hospital', async () => {
    h.ctx = staff('nurse', TENANT_A)
    h.db = createDbMock({
      hospital_beds: { data: [{ id: BED, ward: 'W', bed_number: 'M-01' }], error: null },
      department_tasks: { data: [], error: null },
      hospital_admissions: {
        data: [{ id: 'adm1', patient_id: PATIENT, bed_id: BED, ward: 'W', reason: 'Malaria', admitted_at: '2026-11-20T08:00:00Z', patients: { full_name: 'Okello John', mrn: 'A-2' }, hospital_beds: { bed_number: 'M-01' } }],
        error: null,
      },
    })
    const { GET } = await import('./route')
    const res = await GET(new NextRequest('https://x.test/api/ipd/admissions'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inpatients).toEqual([expect.objectContaining({ id: 'adm1', patientName: 'Okello John', bedNumber: 'M-01' })])
    expect(h.db.eqs('hospital_admissions')).toEqual(expect.arrayContaining([['tenant_id', TENANT_A], ['hospital_id', HOSPITAL_A], ['status', 'admitted']]))
  })
})
