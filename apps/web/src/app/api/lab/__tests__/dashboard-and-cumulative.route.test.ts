import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess, LAB_TENANT } from '../../../../lib/lab/testing/access-double'
import { callsOf, dbMock } from '../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as { rpc: unknown; from: unknown } }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/lab/dashboard', () => import('../../../../lib/lab/dashboard'))

import { GET as dashboard } from '../dashboard/route'
import { GET as cumulative } from '../patients/[id]/results/route'

const PATIENT = '19bc626f-f51a-4bd5-aefd-7a4534babfeb'
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { vi.clearAllMocks(); resetAccess() })

describe('GET /api/lab/dashboard', () => {
  it('needs lab.order.read and scopes every query to the session tenant', async () => {
    const m = dbMock({
      tables: {
        lab_orders: { data: [{ id: 'o1', test_name: 'Malaria RDT', section: 'parasitology', workflow_status: 'RECEIVED', urgency: 'ROUTINE', ordered_at: new Date(Date.now() - 600 * 60_000).toISOString(), catalog_test_id: null, patients: { full_name: 'Demo A' } }] },
        lab_test_catalog: { data: [] },
        lab_results: { data: null, count: 3 },
      },
    })
    state.db = m.db
    const res = await dashboard()
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['order.read'])
    for (const table of ['lab_orders', 'lab_test_catalog', 'lab_results']) {
      for (const calls of m.tableCalls[table] ?? []) expect(callsOf(calls, 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
    }
    const body = await res.json()
    expect(body.criticalOpen).toBe(3)
    expect(body.overdue[0]).toMatchObject({ test: 'Malaria RDT', patient: 'Demo A' })
    expect(body.truncated).toBe(false)
  })

  it('is refused without the capability', async () => {
    accessState.deny = () => 403
    state.db = dbMock().db
    expect((await dashboard()).status).toBe(403)
  })
})

describe('GET /api/lab/patients/[id]/results', () => {
  it('returns verified results grouped by test for a patient in this tenant', async () => {
    const m = dbMock({
      tables: {
        patients: { data: { id: PATIENT, full_name: 'Demo B', mrn: 'M-1', sex: 'F', dob: '1990-01-01' } },
        lab_results: { data: [
          { id: 'r1', loinc_code: '718-7', test_name: 'Haemoglobin', result_value: '11.0', numeric_value: 11, unit: 'g/dL', status: 'RELEASED', verified_at: '2026-10-01T08:00:00Z', created_at: '2026-10-01T08:00:00Z' },
          { id: 'r2', loinc_code: '718-7', test_name: 'Haemoglobin', result_value: '9.0', numeric_value: 9, unit: 'g/dL', status: 'RELEASED', verified_at: '2026-11-01T08:00:00Z', created_at: '2026-11-01T08:00:00Z' },
        ] },
      },
    })
    state.db = m.db
    const res = await cumulative(new Request('http://x'), params(PATIENT))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['result.read'])
    const body = await res.json()
    expect(body.patient.name).toBe('Demo B')
    expect(body.series[0]).toMatchObject({ test: 'Haemoglobin', trend: 'falling' })
    expect(callsOf(m.tableCalls.patients?.[0], 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
    expect(callsOf(m.tableCalls.lab_results?.[0], 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
  })

  it('answers 404 when the patient is not in this tenant, 400 for a bad id', async () => {
    state.db = dbMock({ tables: { patients: { data: null } } }).db
    expect((await cumulative(new Request('http://x'), params(PATIENT))).status).toBe(404)
    expect((await cumulative(new Request('http://x'), params('not-a-uuid'))).status).toBe(400)
  })
})
