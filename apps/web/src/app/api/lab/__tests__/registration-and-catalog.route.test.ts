import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess, LAB_TENANT, LAB_HOSPITAL, LAB_USER } from '../../../../lib/lab/testing/access-double'
import { callsOf, dbMock } from '../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('../../../../lib/lab/testing/db-mock').dbMock>['db'], charge: vi.fn(), audit: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/lab/walk-in', () => import('../../../../lib/lab/walk-in'))
vi.mock('@/lib/lab/catalog', () => import('../../../../lib/lab/catalog'))
vi.mock('@/lib/hospital-shared/audit', () => ({ logHospitalAudit: state.audit }))
vi.mock('@synapse/db/clinical-charge', () => ({
  appendClinicalChargeBestEffort: state.charge,
  resolveServicePrice: vi.fn(async () => null),
  recordInvoiceCreatedEvent: () => ({ list: () => [] }),
}))
vi.mock('@synapse/db/work-queue-persist', () => ({ persistDomainEventsBestEffort: vi.fn(async () => ({ ok: true })) }))

import { POST as walkIn } from '../walk-in/route'
import { POST as referral } from '../referral-orders/route'
import { GET as listCatalog, POST as createCatalog } from '../catalog/route'
import { PATCH as patchCatalog } from '../catalog/[id]/route'
import { POST as seedCatalog } from '../catalog/seed/route'
import { DELETE as deleteRange, POST as createRange } from '../reference-ranges/route'

const CAT_GLU = '4a5b0000-0000-4000-8000-000000000001'
const CAT_MRDT = '4a5b0000-0000-4000-8000-000000000002'
const PATIENT = '19bc626f-f51a-4bd5-aefd-7a4534babfeb'
const req = (body: unknown, method = 'POST', url = 'http://x') => new Request(url, { method, body: JSON.stringify(body) })
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

const walkInReturn = {
  patient: { id: PATIENT, mrn: 'KLA-X', full_name: 'Nakato Jane' },
  encounterId: 'enc-1',
  orders: [
    { id: 'o1', testName: 'Blood glucose', loincCode: '2345-7', catalogTestId: CAT_GLU, price: 15000, currency: 'UGX' },
    { id: 'o2', testName: 'Malaria RDT', loincCode: '58413-6', catalogTestId: CAT_MRDT, price: null, currency: 'UGX' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAccess()
  state.charge.mockResolvedValue({ ok: true, result: { invoiceId: 'inv-1', lineItemId: 'l', created: true, totalAmount: 15000 } })
})

describe('POST /api/lab/walk-in', () => {
  it('registers patient, visit and all tests in one call, then bills the priced test only', async () => {
    const m = dbMock({ rpc: (fn) => (fn === 'lab_create_walk_in' ? { data: walkInReturn } : { data: null }) })
    state.db = m.db
    const res = await walkIn(req({ patient: { fullName: 'Nakato Jane', sex: 'F', dateOfBirth: '1990-04-02' }, catalogTestIds: [CAT_GLU, CAT_MRDT], referralSource: 'Dr Okello' }))
    expect(res.status).toBe(201)
    expect(accessState.calls).toEqual(['order.create'])
    const p = (m.rpc.mock.calls[0]![1] as { p: Record<string, unknown> }).p
    expect(p).toMatchObject({ tenant_id: LAB_TENANT, hospital_id: LAB_HOSPITAL, actor_id: LAB_USER, catalog_ids: [CAT_GLU, CAT_MRDT], order_source: 'walk_in' })
    expect((p.patient as Record<string, unknown>).full_name).toBe('Nakato Jane')
    expect(String((p.patient as Record<string, unknown>).mrn)).toMatch(/^[0-9A-F]{4}-/)
    expect(state.charge).toHaveBeenCalledTimes(1)
    expect(state.charge.mock.calls[0]![1]).toMatchObject({ tenantId: LAB_TENANT, patientId: PATIENT, encounterId: 'enc-1', unitPrice: 15000, sourceTable: 'lab_orders', sourceId: 'o1' })
    const body = await res.json()
    expect(body.billing).toMatchObject({ invoiceId: 'inv-1', charged: ['o1'], unpriced: ['Malaria RDT'] })
  })

  it('an existing patient is referenced by id only (the database checks the tenant)', async () => {
    const m = dbMock({ rpc: () => ({ error: { message: 'LAB_PATIENT_NOT_FOUND', code: 'LB404' } }) })
    state.db = m.db
    const res = await walkIn(req({ patient: { id: PATIENT }, catalogTestIds: [CAT_GLU] }))
    expect(res.status).toBe(404)
    expect((m.rpc.mock.calls[0]![1] as { p: { patient: unknown } }).p.patient).toEqual({ id: PATIENT })
  })

  it('400 with no tests, a bad body, or more than 30 tests; 403 without order.create', async () => {
    state.db = dbMock().db
    expect((await walkIn(req({ patient: { id: PATIENT } }))).status).toBe(400)
    expect((await walkIn(req({ patient: { fullName: 'X' }, catalogTestIds: [CAT_GLU] }))).status).toBe(400)
    expect((await walkIn(req({ patient: { id: PATIENT }, catalogTestIds: Array(31).fill(CAT_GLU) }))).status).toBe(400)
    accessState.deny = () => 403
    expect((await walkIn(req({ patient: { id: PATIENT }, catalogTestIds: [CAT_GLU] }))).status).toBe(403)
  })

  it('bill:false registers without charging', async () => {
    state.db = dbMock({ rpc: () => ({ data: walkInReturn }) }).db
    const res = await walkIn(req({ patient: { id: PATIENT }, catalogTestIds: [CAT_GLU], bill: false }))
    expect(res.status).toBe(201)
    expect(state.charge).not.toHaveBeenCalled()
  })
})

describe('POST /api/lab/referral-orders (kept for existing callers)', () => {
  it('goes through the same transactional registration as a referral with one free test', async () => {
    const m = dbMock({ rpc: () => ({ data: { ...walkInReturn, orders: [walkInReturn.orders[0]] } }) })
    state.db = m.db
    const res = await referral(req({ patientName: 'Kato', sex: 'M', testName: 'Glucose', loincCode: '2345-7', referralSource: 'Mengo' }))
    expect(res.status).toBe(201)
    const p = (m.rpc.mock.calls[0]![1] as { p: Record<string, unknown> }).p
    expect(p).toMatchObject({ order_source: 'referral', free_tests: [{ test_name: 'Glucose', loinc_code: '2345-7' }], referral_source: 'Mengo' })
    expect(m.from).not.toHaveBeenCalledWith('patients')
    expect((await res.json()).order).toMatchObject({ id: 'o1', status: 'ORDERED' })
  })
})

describe('test catalogue', () => {
  it('lists only this tenant’s active tests', async () => {
    const m = dbMock({ tables: { lab_test_catalog: { data: [{ id: CAT_GLU }] } } })
    state.db = m.db
    const res = await listCatalog(new Request('http://x/api/lab/catalog'))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['order.read'])
    const calls = m.tableCalls.lab_test_catalog![0]!
    expect(callsOf(calls, 'eq')).toEqual(expect.arrayContaining([['tenant_id', LAB_TENANT], ['is_active', true]]))
  })

  it('creating needs catalog.manage, validates, and stamps the tenant', async () => {
    const m = dbMock({ tables: { lab_test_catalog: { data: { id: CAT_GLU, code: 'GLU' } } } })
    state.db = m.db
    expect((await createCatalog(req({ code: 'GLU', name: 'G', section: 'chemistry' }))).status).toBe(400)
    expect((await createCatalog(req({ code: 'GLU', name: 'Glucose', section: 'kitchen' }))).status).toBe(400)
    const res = await createCatalog(req({ code: 'glu', name: 'Glucose', section: 'chemistry', price: 15000, loincCode: '2345-7', tenantId: 'other' }))
    expect(res.status).toBe(201)
    expect(accessState.calls.at(-1)).toBe('catalog.manage')
    const insert = callsOf(m.tableCalls.lab_test_catalog![0], 'insert')[0]![0] as Record<string, unknown>
    expect(insert).toMatchObject({ tenant_id: LAB_TENANT, code: 'GLU', price: 15000, section: 'chemistry' })
    expect(insert).not.toHaveProperty('tenantId')
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAB_CATALOG_CREATED' }))
    accessState.deny = (cap) => (cap === 'catalog.manage' ? 403 : null)
    expect((await createCatalog(req({ code: 'X', name: 'Xx', section: 'chemistry' }))).status).toBe(403)
  })

  it('PATCH is tenant-scoped and 404s another tenant’s test', async () => {
    const m = dbMock({ tables: { lab_test_catalog: { data: null } } })
    state.db = m.db
    const res = await patchCatalog(req({ price: 20000 }, 'PATCH'), idParams(CAT_GLU))
    expect(res.status).toBe(404)
    expect(callsOf(m.tableCalls.lab_test_catalog![0], 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
    expect((await patchCatalog(req({}, 'PATCH'), idParams(CAT_GLU))).status).toBe(400)
  })

  it('PATCH changes only the fields it names (no defaults sneak in)', async () => {
    const m = dbMock({ tables: { lab_test_catalog: { data: { id: CAT_GLU } } } })
    state.db = m.db
    expect((await patchCatalog(req({ price: 20000 }, 'PATCH'), idParams(CAT_GLU))).status).toBe(200)
    const update = callsOf(m.tableCalls.lab_test_catalog![0], 'update')[0]![0] as Record<string, unknown>
    expect(Object.keys(update).sort()).toEqual(['price', 'updated_at'])
    expect((await patchCatalog(req({ tenant_id: 'x' }, 'PATCH'), idParams(CAT_GLU))).status).toBe(400)
  })

  it('seeding calls the starter catalogue for this tenant', async () => {
    const m = dbMock({ rpc: () => ({ data: 18 }) })
    state.db = m.db
    const res = await seedCatalog()
    expect(await res.json()).toEqual({ added: 18 })
    expect(m.rpc).toHaveBeenCalledWith('lab_seed_starter_catalog', { p_tenant_id: LAB_TENANT })
  })
})

describe('reference ranges', () => {
  it('validates the interval and stores it for this tenant only', async () => {
    const m = dbMock({ tables: { lab_reference_ranges: { data: { id: 'r1' } } } })
    state.db = m.db
    expect((await createRange(req({ loincCode: '718-7', testName: 'Hb', unit: 'g/dL', low: 15, high: 12 }))).status).toBe(400)
    expect((await createRange(req({ loincCode: '718-7', testName: 'Hb', unit: 'g/dL', low: 12, high: 15, criticalLow: 13 }))).status).toBe(400)
    const res = await createRange(req({ loincCode: '718-7', testName: 'Hb', unit: 'g/dL', sex: 'F', low: 12, high: 15, criticalLow: 7 }))
    expect(res.status).toBe(201)
    expect(callsOf(m.tableCalls.lab_reference_ranges![0], 'insert')[0]![0]).toMatchObject({ tenant_id: LAB_TENANT, sex: 'F', low: 12, critical_low: 7 })
  })

  it('DELETE can only remove this tenant’s own rows (never the national pack)', async () => {
    const m = dbMock({ tables: { lab_reference_ranges: { data: null } } })
    state.db = m.db
    const res = await deleteRange(new Request(`http://x/api/lab/reference-ranges?id=${CAT_GLU}`, { method: 'DELETE' }))
    expect(res.status).toBe(404)
    expect(callsOf(m.tableCalls.lab_reference_ranges![0], 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
  })
})
