import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess, LAB_TENANT } from '../../../../../../lib/lab/testing/access-double'
import { dbMock } from '../../../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as { rpc: unknown; from: unknown }, audit: vi.fn(), voidCharge: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/hospital-shared/audit', () => ({ logHospitalAudit: state.audit }))
vi.mock('@synapse/db/clinical-charge', () => ({ voidClinicalCharge: state.voidCharge }))
vi.mock('@synapse/db/clinical-timeline', () => ({ clinicalActionTimelineEvent: vi.fn(), publishClinicalTimelineBestEffort: vi.fn() }))
vi.mock('@synapse/db/identity-persist', () => ({ publishTimelineEvent: vi.fn() }))
vi.mock('@synapse/db/work-queue-persist', () => ({ rowToDepartmentTask: vi.fn(), persistWorkQueueArtifactsBestEffort: vi.fn(async () => ({ errors: [] })) }))

import { POST } from './route'

const ORDER = 'e76497a1-3a54-4984-827c-f6c339edbf99'
const row = {
  id: ORDER, tenant_id: LAB_TENANT, encounter_id: 'e6edbd38-08be-4f07-aeff-3ad268e939fe', patient_id: '19bc626f-f51a-4bd5-aefd-7a4534babfeb',
  loinc_code: '2345-7', test_name: 'Glucose', urgency: 'ROUTINE', workflow_status: 'ORDERED', ordered_by: '81456280-e996-4ff3-84ba-cada261d5061',
  ordered_at: '2026-11-21T08:00:00Z', correlation_id: 'e6edbd38-08be-4f07-aeff-3ad268e939fe', is_synthetic: false,
}
const call = (body: unknown) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: ORDER }) })

beforeEach(() => { vi.clearAllMocks(); resetAccess(); state.voidCharge.mockResolvedValue({ voided: true }) })

describe('POST /api/lab/orders/[id]/cancel', () => {
  it('needs lab.order.cancel (which now exists) and a reason', async () => {
    state.db = dbMock({ tables: { lab_orders: { data: row }, department_tasks: { data: [] } } }).db
    expect((await call({})).status).toBe(400)
    const res = await call({ reason: 'Duplicate order' })
    expect(res.status).toBe(200)
    expect(accessState.calls.at(-1)).toBe('order.cancel')
    expect(await res.json()).toMatchObject({ cancelled: true, chargeVoided: true })
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAB_ORDER_CANCELLED' }))
  })

  it('is refused without the capability', async () => {
    accessState.deny = () => 403
    state.db = dbMock().db
    expect((await call({ reason: 'x' })).status).toBe(403)
  })

  it('cannot cancel a released result', async () => {
    state.db = dbMock({ tables: { lab_orders: { data: { ...row, workflow_status: 'RELEASED' } } } }).db
    expect((await call({ reason: 'x' })).status).toBe(409)
  })
})
