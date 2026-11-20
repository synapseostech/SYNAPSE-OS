import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createDbMock, MISSING_RPC, staff, TENANT_A, USER } from '../../../../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({
  db: null as never as ReturnType<typeof createDbMock>,
  ctx: null as unknown,
  cap: vi.fn(),
  mod: vi.fn(),
  audit: vi.fn(),
  legacy: vi.fn(),
  events: vi.fn(),
}))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('@/lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: (...a: unknown[]) => h.cap(...a),
  gateHospitalModule: (...a: unknown[]) => h.mod(...a),
  logHospitalAudit: (...a: unknown[]) => h.audit(...a),
}))
vi.mock('@/lib/hospital-dept', async () => ({
  ...(await import('../../../../../../../lib/hospital-dept/schemas')),
  ...(await import('../../../../../../../lib/hospital-dept/rpc-errors')),
  requireHospitalStaffContext: async () => h.ctx,
}))
vi.mock('@synapse/db/clinical-payment', () => ({
  recordEncounterPayment: (...a: unknown[]) => h.legacy(...a),
  recordPaymentRecordedEvent: () => ({ list: () => [{ id: 'evt' }] }),
}))
vi.mock('@synapse/db/clinical-timeline', () => ({
  paymentRecordedTimelineEvent: (x: unknown) => x,
  publishClinicalTimelineBestEffort: vi.fn(),
}))
vi.mock('@synapse/db/identity-persist', () => ({ publishTimelineEvent: vi.fn() }))
vi.mock('@synapse/db/work-queue-persist', () => ({
  persistDomainEventsBestEffort: (...a: unknown[]) => h.events(...a),
  rowToDepartmentTask: (r: unknown) => r,
}))
vi.mock('@synapse/db/work-queue', () => ({ WorkQueue: class {} }))

const ENCOUNTER = '72603ece-b91a-45ad-a6bc-c59bff1162db'
const pay = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST(
    new NextRequest(`https://x.test/api/hospital/billing/encounter/${ENCOUNTER}/pay`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: ENCOUNTER }) },
  )
}

beforeEach(() => {
  h.cap.mockResolvedValue(null)
  h.mod.mockResolvedValue(null)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/hospital/billing/encounter/[id]/pay', () => {
  it('requires billing.payment.record', async () => {
    h.ctx = staff('nurse')
    h.db = createDbMock({})
    h.cap.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await pay({ amount: 1000 })).status).toBe(403)
    expect(h.cap).toHaveBeenCalledWith(expect.anything(), 'payment', 'record', 'billing')
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it('records the payment in one atomic RPC and does not touch department_tasks itself', async () => {
    h.ctx = staff('cashier', TENANT_A)
    h.db = createDbMock({})
    h.db.setRpc('hospital_record_payment', {
      data: {
        paymentId: 'pay1', invoiceId: 'inv1', patientId: 'p1', receiptNumber: 'RCP-20261120-0001', amount: 15000,
        paidAmount: 15000, totalAmount: 50000, insuranceCover: 35000, balanceDue: 0, status: 'paid', created: true, billingTaskCompleted: true,
      },
      error: null,
    })
    const res = await pay({ amount: 15000, payment_method: 'mobile_money', payment_ref: 'MTN-1', idempotency_key: 'k1' })
    expect(res.status).toBe(200)
    expect(h.db.rpcCalls).toEqual([{
      fn: 'hospital_record_payment',
      args: {
        p_tenant_id: TENANT_A, p_encounter_id: ENCOUNTER, p_amount: 15000, p_payment_method: 'mobile_money', p_actor_id: USER,
        p_payment_ref: 'MTN-1', p_idempotency_key: 'k1', p_notes: null,
      },
    }])
    expect(h.db.calls).toHaveLength(0)
    expect(h.legacy).not.toHaveBeenCalled()
    expect(h.events).toHaveBeenCalledTimes(1)
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'billing_payments', recordId: 'pay1' }))
    const body = await res.json()
    expect(body.payment).toMatchObject({ receiptNumber: 'RCP-20261120-0001', balanceDue: 0, insuranceCover: 35000 })
  })

  it('an idempotent retry emits no event and no audit row', async () => {
    h.ctx = staff('cashier')
    h.db = createDbMock({})
    h.db.setRpc('hospital_record_payment', {
      data: { paymentId: 'pay1', invoiceId: 'inv1', receiptNumber: 'R', amount: 1, paidAmount: 1, totalAmount: 2, balanceDue: 1, status: 'partially_paid', created: false },
      error: null,
    })
    expect((await pay({ amount: 1, idempotency_key: 'k1' })).status).toBe(200)
    expect(h.events).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it.each([
    ['AMOUNT_EXCEEDS_BALANCE', 409],
    ['INVOICE_ALREADY_PAID', 409],
    ['INVOICE_NOT_FOUND', 404],
  ])('maps %s to %i', async (code, status) => {
    h.ctx = staff('cashier')
    h.db = createDbMock({})
    h.db.setRpc('hospital_record_payment', { data: null, error: { code: 'P0001', message: code } })
    const res = await pay({ amount: 1000 })
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(code)
  })

  it('hides unexpected database errors', async () => {
    h.ctx = staff('cashier')
    h.db = createDbMock({})
    h.db.setRpc('hospital_record_payment', { data: null, error: { code: '23503', message: 'fk billing_payments_secret' } })
    const res = await pay({ amount: 1000 })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('payment_failed')
  })

  it('uses the legacy path until the migration is applied', async () => {
    h.ctx = staff('billing_officer', TENANT_A)
    h.db = createDbMock({ billing_invoices: { data: { patient_id: 'p1' }, error: null }, department_tasks: { data: null, error: null } })
    h.db.setRpc('hospital_record_payment', MISSING_RPC)
    h.legacy.mockResolvedValue({ paymentId: 'pay1', invoiceId: 'inv1', receiptNumber: 'R', amount: 1000, paidAmount: 1000, totalAmount: 1000, balanceDue: 0, status: 'paid', created: true })
    expect((await pay({ amount: 1000 })).status).toBe(200)
    expect(h.legacy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: TENANT_A, encounterId: ENCOUNTER }))
    expect(h.db.eqs('department_tasks')).toContainEqual(['tenant_id', TENANT_A])
  })
})
