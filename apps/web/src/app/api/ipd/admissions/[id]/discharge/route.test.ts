import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createDbMock, HOSPITAL_A, MISSING_RPC, staff, TENANT_A, USER } from '../../../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({ db: null as never as ReturnType<typeof createDbMock>, ctx: null as unknown, cap: vi.fn(), mod: vi.fn(), audit: vi.fn() }))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../../../lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: (...a: unknown[]) => h.cap(...a),
  gateHospitalModule: (...a: unknown[]) => h.mod(...a),
  logHospitalAudit: (...a: unknown[]) => h.audit(...a),
}))
vi.mock('../../../../../../lib/hospital-dept', async () => ({
  ...(await import('../../../../../../lib/hospital-dept/schemas')),
  ...(await import('../../../../../../lib/hospital-dept/rpc-errors')),
  requireHospitalStaffContext: async () => h.ctx,
}))

const ADMISSION = '55555555-5555-4555-8555-555555555555'
const discharge = async (body: unknown, id = ADMISSION) => {
  const { POST } = await import('./route')
  return POST(new NextRequest(`https://x.test/api/ipd/admissions/${id}/discharge`, { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  h.cap.mockResolvedValue(null)
  h.mod.mockResolvedValue(null)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/ipd/admissions/[id]/discharge', () => {
  it('requires ipd.admission.discharge', async () => {
    h.ctx = staff('nurse')
    h.db = createDbMock({})
    h.cap.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await discharge({ disposition: 'home' })).status).toBe(403)
    expect(h.cap).toHaveBeenCalledWith(expect.anything(), 'admission', 'discharge', 'ipd')
  })

  it('validates the disposition', async () => {
    h.ctx = staff('doctor')
    h.db = createDbMock({})
    expect((await discharge({ disposition: 'teleported' })).status).toBe(400)
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it('discharges in one RPC scoped to the session tenant and hospital', async () => {
    h.ctx = staff('doctor', TENANT_A)
    h.db = createDbMock({})
    h.db.setRpc('hospital_discharge_patient', { data: { admissionId: ADMISSION, status: 'discharged', tasksCompleted: 1 }, error: null })
    const res = await discharge({ disposition: 'home', summary: 'Recovered' })
    expect(res.status).toBe(200)
    expect(h.db.rpcCalls).toEqual([{
      fn: 'hospital_discharge_patient',
      args: { p_tenant_id: TENANT_A, p_hospital_id: HOSPITAL_A, p_admission_id: ADMISSION, p_actor_id: USER, p_disposition: 'home', p_summary: 'Recovered' },
    }])
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'hospital_admissions', recordId: ADMISSION }))
  })

  it('maps ALREADY_DISCHARGED and unknown ids', async () => {
    h.ctx = staff('doctor')
    h.db = createDbMock({})
    h.db.setRpc('hospital_discharge_patient', { data: null, error: { code: 'P0001', message: 'ALREADY_DISCHARGED' } })
    expect((await discharge({ disposition: 'home' })).status).toBe(409)
    expect((await discharge({ disposition: 'home' }, 'not-a-uuid')).status).toBe(404)
  })

  it('503s before the migration is applied', async () => {
    h.ctx = staff('doctor')
    h.db = createDbMock({})
    h.db.setRpc('hospital_discharge_patient', MISSING_RPC)
    expect((await discharge({ disposition: 'home' })).status).toBe(503)
  })
})
