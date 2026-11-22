import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess, LAB_TENANT, LAB_USER } from '../../../../lib/lab/testing/access-double'
import { callsOf, dbMock } from '../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('../../../../lib/lab/testing/db-mock').dbMock>['db'], audit: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/lab/qc', () => import('../../../../lib/lab/qc'))
vi.mock('@/lib/hospital-shared/audit', () => ({ logHospitalAudit: state.audit }))

import { GET as board } from '../qc/route'
import { POST as createMaterial } from '../qc/materials/route'
import { PATCH as patchMaterial } from '../qc/materials/[id]/route'
import { POST as recordRun } from '../qc/runs/route'
import { POST as correct } from '../qc/runs/[id]/corrective-action/route'

const M1 = '0a000000-0000-4000-8000-000000000001'
const M2 = '0a000000-0000-4000-8000-000000000002'
const RUN = '0b000000-0000-4000-8000-000000000001'
const req = (body: unknown, method = 'POST', url = 'http://x') => new Request(url, { method, body: JSON.stringify(body) })
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })
const mat = (id: string, o: Record<string, unknown> = {}) => ({
  id, loinc_code: '718-7', analyte_name: 'Haemoglobin', unit: 'g/dL', material_name: 'Haem control', lot_number: 'H1', level: id === M1 ? 'L1' : 'L2',
  target_mean: 6, target_sd: 0.2, expires_on: null, device_id: null, is_active: true, last_run_at: '2026-11-22T06:00:00Z', last_run_status: 'accepted', ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetAccess()
})

describe('GET /api/lab/qc', () => {
  it('needs lab.qc.record and reads only this tenant, runs bounded by days', async () => {
    const m = dbMock({ tables: {
      lab_qc_materials: { data: [mat(M1, { last_run_status: 'rejected' }), mat(M2)] },
      lab_qc_runs: { data: [{ id: RUN, material_id: M1, value: 6.5, z_score: 2.5, status: 'rejected', rules: ['2_2s'], run_at: '2026-11-22T06:00:00Z' }] },
    } })
    state.db = m.db
    const res = await board(new Request('http://x/api/lab/qc?days=9999'))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['qc.record'])
    expect(callsOf(m.tableCalls.lab_qc_materials![0], 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
    const runCalls = m.tableCalls.lab_qc_runs![0]
    expect(callsOf(runCalls, 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
    expect(callsOf(runCalls, 'in')).toEqual([['material_id', [M1, M2]]])
    const since = Date.parse(String(callsOf(runCalls, 'gte')[0]![1]))
    expect(Date.now() - since).toBeLessThanOrEqual(180 * 86_400_000 + 5000)
    const body = await res.json()
    expect(body.days).toBe(180)
    expect(body.summary[0]).toMatchObject({ loincCode: '718-7', locked: true, failedLevels: ['L1'] })
    expect(body.materials[0].runs).toHaveLength(1)
    expect(body.canManage).toBe(true) // lab_scientist
  })

  it('does not query runs when there are no controls; 403 without the capability', async () => {
    const m = dbMock({ tables: { lab_qc_materials: { data: [] } } })
    state.db = m.db
    expect((await board(new Request('http://x'))).status).toBe(200)
    expect(m.tableCalls.lab_qc_runs).toBeUndefined()
    accessState.deny = () => 403
    expect((await board(new Request('http://x'))).status).toBe(403)
  })
})

describe('POST /api/lab/qc/runs', () => {
  it('sends the batch to lab_qc_record with the tenant and actor from the session', async () => {
    const m = dbMock({ rpc: () => ({ data: { batchId: 'b', status: 'rejected', runs: [] } }) })
    state.db = m.db
    const res = await recordRun(req({ results: [{ materialId: M1, value: 6.5 }, { materialId: M2, value: 11.2 }], comment: 'AM run' }))
    expect(res.status).toBe(201)
    expect(accessState.calls).toEqual(['qc.record'])
    expect(m.rpc).toHaveBeenCalledWith('lab_qc_record', { p: {
      tenant_id: LAB_TENANT, actor_id: LAB_USER, actor_role: 'lab_scientist', comment: 'AM run', run_at: null,
      results: [{ material_id: M1, value: 6.5 }, { material_id: M2, value: 11.2 }],
    } })
    expect((await res.json()).batch.status).toBe('rejected')
  })

  it('does not accept a tenant or status from the client, and maps database refusals', async () => {
    state.db = dbMock().db
    expect((await recordRun(req({ results: [{ materialId: M1, value: 6 }], tenantId: 'x' }))).status).toBe(400)
    expect((await recordRun(req({ results: [{ materialId: M1, value: 6, status: 'accepted' }] }))).status).toBe(400)
    state.db = dbMock({ rpc: () => ({ error: { code: 'LB409', message: 'LAB_QC_LOT_EXPIRED: lot H1 of Haemoglobin L1 expired on 2026-11-01' } }) }).db
    const res = await recordRun(req({ results: [{ materialId: M1, value: 6 }] }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Lot H1 of Haemoglobin L1 expired on 2026-11-01')
  })
})

describe('QC controls (lab.qc.manage)', () => {
  const body = { loincCode: '718-7', analyteName: 'Haemoglobin', materialName: 'Haem control', lotNumber: 'H1', level: 'L1', targetMean: 6, targetSd: 0.2 }

  it('creates a control for this tenant and audits it', async () => {
    const m = dbMock({ tables: { lab_qc_materials: { data: mat(M1) } } })
    state.db = m.db
    const res = await createMaterial(req(body))
    expect(res.status).toBe(201)
    expect(accessState.calls).toEqual(['qc.manage'])
    expect(callsOf(m.tableCalls.lab_qc_materials![0], 'insert')[0]![0]).toMatchObject({ tenant_id: LAB_TENANT, created_by: LAB_USER, loinc_code: '718-7', level: 'L1', target_sd: 0.2 })
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAB_QC_MATERIAL_CREATED' }))
  })

  it('409 for a second active control with the same lot and level; another tenant’s analyser is refused', async () => {
    state.db = dbMock({ tables: { lab_qc_materials: { error: { message: 'duplicate key value violates unique constraint' } } } }).db
    expect((await createMaterial(req(body))).status).toBe(409)
    state.db = dbMock({ tables: { lab_devices: { data: null } } }).db
    expect((await createMaterial(req({ ...body, deviceId: M2 }))).status).toBe(400)
  })

  it('bench staff cannot set up or change controls', async () => {
    accessState.deny = (c) => (c === 'qc.manage' ? 403 : null)
    state.db = dbMock().db
    expect((await createMaterial(req(body))).status).toBe(403)
    expect((await patchMaterial(req({ isActive: false }, 'PATCH'), idParams(M1))).status).toBe(403)
  })

  it('switching off a rejected control is audited as lifting the lock', async () => {
    const m = dbMock({ tables: { lab_qc_materials: { data: mat(M1, { last_run_status: 'rejected' }) } } })
    state.db = m.db
    const res = await patchMaterial(req({ isActive: false }, 'PATCH'), idParams(M1))
    expect(res.status).toBe(200)
    expect(callsOf(m.tableCalls.lab_qc_materials![1], 'eq')).toEqual([['id', M1], ['tenant_id', LAB_TENANT]])
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAB_QC_LOCK_RELEASED_BY_DEACTIVATION', recordId: M1 }))
  })

  it('lot and level are fixed; unknown ids are 404', async () => {
    state.db = dbMock().db
    expect((await patchMaterial(req({ lotNumber: 'H2' }, 'PATCH'), idParams(M1))).status).toBe(400)
    expect((await patchMaterial(req({ isActive: false }, 'PATCH'), idParams('nope'))).status).toBe(404)
    expect((await patchMaterial(req({ isActive: false }, 'PATCH'), idParams(M1))).status).toBe(404)
  })
})

describe('POST /api/lab/qc/runs/[id]/corrective-action', () => {
  it('writes once, on a rejected run of this tenant', async () => {
    const m = dbMock({ tables: { lab_qc_runs: { data: { id: RUN, status: 'rejected', corrective_action: 'Recalibrated' } } } })
    state.db = m.db
    const res = await correct(req({ action: 'Recalibrated' }), idParams(RUN))
    expect(res.status).toBe(200)
    const calls = m.tableCalls.lab_qc_runs![0]
    expect(callsOf(calls, 'eq')).toEqual([['id', RUN], ['tenant_id', LAB_TENANT], ['status', 'rejected']])
    expect(callsOf(calls, 'is')).toEqual([['corrective_action', null]])
    expect(callsOf(calls, 'update')[0]![0]).toMatchObject({ corrective_action: 'Recalibrated', corrected_by: LAB_USER })
  })

  it('409 when already recorded or the run was not rejected; 404 for another tenant’s run', async () => {
    let n = 0
    state.db = dbMock({ tables: { lab_qc_runs: () => (n++ === 0 ? { data: null } : { data: { id: RUN, status: 'rejected', corrective_action: 'x' } }) } }).db
    expect((await correct(req({ action: 'Recalibrated' }), idParams(RUN))).status).toBe(409)
    n = 0
    state.db = dbMock({ tables: { lab_qc_runs: () => (n++ === 0 ? { data: null } : { data: { id: RUN, status: 'accepted', corrective_action: null } }) } }).db
    expect((await correct(req({ action: 'Recalibrated' }), idParams(RUN))).status).toBe(409)
    state.db = dbMock({ tables: { lab_qc_runs: { data: null } } }).db
    expect((await correct(req({ action: 'Recalibrated' }), idParams(RUN))).status).toBe(404)
  })
})
