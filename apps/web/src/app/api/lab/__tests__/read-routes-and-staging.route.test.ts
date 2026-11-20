import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { accessState, resetAccess, LAB_TENANT } from '../../../../lib/lab/testing/access-double'
import { callsOf, dbMock } from '../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as { rpc: unknown; from: unknown }, run: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/lab/worklist', () => import('../../../../lib/lab/worklist'))
vi.mock('@/lib/lab/roles', () => import('../../../../lib/lab/roles'))
vi.mock('@/lib/lab/engine', async () => {
  class LabActionError extends Error { constructor(readonly code: string, readonly status: number, message?: string) { super(message ?? code) } }
  return { LabActionError, runLabAction: state.run }
})
vi.mock('@/lib/platform/auth', () => ({ hasPlatformAdminAccess: () => false, requirePlatformAdminApi: async () => ({ ok: false }) }))
vi.mock('@/lib/platform/simulation-runtime', () => ({ getSimulationEngine: vi.fn(), serializeRun: vi.fn() }))

import { GET as worklist } from '../worklist/route'
import { GET as verifyQueue } from '../verify-queue/route'
import { GET as specimens } from '../specimens/route'
import { GET as results } from '../results/route'
import { GET as mobileLab } from '../../mobile/lab/route'
import { POST as accept } from '../staging/[id]/accept/route'
import { LabActionError } from '@/lib/lab/engine'

const STAGING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ORDER = 'e76497a1-3a54-4984-827c-f6c339edbf99'

function orderRow(status: string, withResult = true) {
  return {
    id: ORDER, tenant_id: LAB_TENANT, encounter_id: 'e', patient_id: 'p', loinc_code: '2345-7', test_name: 'Glucose', section: 'chemistry',
    urgency: 'ROUTINE', workflow_status: status, order_source: 'walk_in', accession_number: 'LAB-1', specimen_id: null,
    ordered_at: '2026-11-21T10:00:00.000Z', patients: { full_name: 'Nakato Jane', mrn: 'KLA-1', sex: 'F', dob: null },
    lab_results: withResult ? [{ id: 'r', result_value: '6.5', unit: 'mmol/L', reference_range: '4–7', abnormal_flag: 'N', is_critical: false, critical_scientist_ack_at: null }] : [],
  }
}

beforeEach(() => { vi.clearAllMocks(); resetAccess() })

describe('read routes are capability-gated and tenant-scoped', () => {
  it.each([
    ['worklist', () => worklist(new Request('http://x/api/lab/worklist?section=chemistry&view=bench')), 'order.read', 'lab_orders'],
    ['verify queue', () => verifyQueue(new Request('http://x/api/lab/verify-queue')), 'result.verify', 'lab_orders'],
    ['specimens', () => specimens(new Request('http://x/api/lab/specimens')), 'order.read', 'lab_specimens'],
    ['results', () => results(new Request('http://x/api/lab/results?critical=1')), 'result.read', 'lab_results'],
  ])('%s', async (_name, call, capability, table) => {
    const m = dbMock({ tables: { [table]: { data: [] } } })
    state.db = m.db
    const res = await call()
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual([capability])
    expect(m.from).toHaveBeenCalledTimes(1)
    expect(callsOf(m.tableCalls[table]![0], 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
  })

  it('a cashier (no lab capability) gets 403 from the specimen and result lists, which used to be open', async () => {
    accessState.deny = () => 403
    state.db = dbMock().db
    expect((await specimens(new Request('http://x'))).status).toBe(403)
    expect((await results(new Request('http://x'))).status).toBe(403)
  })

  it('the worklist returns a next-page cursor', async () => {
    state.db = dbMock({ tables: { lab_orders: { data: Array.from({ length: 3 }, (_, i) => ({ ...orderRow('RECEIVED'), id: `00000000-0000-4000-8000-00000000000${i}` })) } } }).db
    const body = await (await worklist(new Request('http://x/api/lab/worklist?limit=2'))).json()
    expect(body.orders).toHaveLength(2)
    expect(typeof body.nextCursor).toBe('string')
  })
})

describe('GET /api/mobile/lab', () => {
  it('reads lab_orders behind lab.order.read and shows values only after release', async () => {
    const m = dbMock({ tables: { lab_orders: { data: [orderRow('VERIFICATION_PENDING'), { ...orderRow('RELEASED'), id: '00000000-0000-4000-8000-000000000009' }], count: 4 } } })
    state.db = m.db
    const res = await mobileLab(new NextRequest('http://x/api/mobile/lab', { headers: { authorization: 'Bearer t' } }))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['order.read'])
    expect(m.from).not.toHaveBeenCalledWith('encounter_orders')
    const body = await res.json()
    expect(body.orders[0].result).toBeNull()
    expect(body.orders[1].result).toMatchObject({ value: '6.5', unit: 'mmol/L' })
    expect(body.stats).toEqual({ pending: 4, inProgress: 4, collected: 4 })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('a pharmacy account with a token is refused', async () => {
    accessState.deny = () => 403
    state.db = dbMock().db
    expect((await mobileLab(new NextRequest('http://x/api/mobile/lab', { headers: { authorization: 'Bearer t' } }))).status).toBe(403)
  })

  it('look-up by accession skips the counts', async () => {
    const m = dbMock({ tables: { lab_orders: { data: [orderRow('RELEASED')] } } })
    state.db = m.db
    await mobileLab(new NextRequest('http://x/api/mobile/lab?q=LAB-20261121-000001'))
    expect(m.from).toHaveBeenCalledTimes(1)
    expect(callsOf(m.tableCalls.lab_orders![0], 'ilike')).toEqual([['accession_number', 'LAB-20261121-000001%']])
  })
})

describe('POST /api/lab/staging/[id]/accept', () => {
  const params = { params: Promise.resolve({ id: STAGING }) }
  const staging = { id: STAGING, status: 'READY_FOR_REVIEW', lab_order_id: ORDER, mapped_loinc: '2345-7', value: '6.2', device_id: 'dev', clinical_result_id: null }

  it('enters the analyser value through the engine with the analyte check, then marks the staging row', async () => {
    const m = dbMock({ tables: { lab_result_staging: { data: staging } } })
    state.db = m.db
    state.run.mockResolvedValue({ order: { id: ORDER, status: 'VERIFICATION_PENDING' }, result: { id: 'res-1' }, critical: false, warnings: [] })
    const res = await accept(new Request('http://x', { method: 'POST' }) as never, params)
    expect(res.status).toBe(200)
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER, action: 'enter_result', extra: expect.objectContaining({ value: '6.2', source: 'ANALYZER', expectLoinc: '2345-7' }) }))
    const update = callsOf(m.tableCalls.lab_result_staging![1], 'update')[0]![0]
    expect(update).toMatchObject({ status: 'ACCEPTED', clinical_result_id: 'res-1', reviewed_by: accessState.ctx.userId })
  })

  it('refuses a mismatched analyte and leaves the staging row alone', async () => {
    const m = dbMock({ tables: { lab_result_staging: { data: { ...staging, mapped_loinc: '718-7' } } } })
    state.db = m.db
    state.run.mockRejectedValue(new LabActionError('LAB_ANALYTE_MISMATCH', 409))
    const res = await accept(new Request('http://x', { method: 'POST' }) as never, params)
    expect(res.status).toBe(409)
    expect(m.tableCalls.lab_result_staging).toHaveLength(1)
  })

  it('bench technicians cannot accept analyser results; lab admins can', async () => {
    state.db = dbMock({ tables: { lab_result_staging: { data: staging } } }).db
    accessState.ctx.role = 'lab_tech'
    expect((await accept(new Request('http://x', { method: 'POST' }) as never, params)).status).toBe(403)
    accessState.ctx.role = 'lab_admin'
    state.run.mockResolvedValue({ order: { id: ORDER, status: 'VERIFICATION_PENDING' }, result: { id: 'res-1' }, critical: false, warnings: [] })
    expect((await accept(new Request('http://x', { method: 'POST' }) as never, params)).status).toBe(200)
  })
})
