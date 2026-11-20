import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createDbMock, staff, TENANT_A, TENANT_B } from '../../../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({ db: null as never as ReturnType<typeof createDbMock>, ctx: null as unknown, cap: vi.fn(), mod: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../../../lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: (...a: unknown[]) => h.cap(...a),
  gateHospitalModule: (...a: unknown[]) => h.mod(...a),
}))
vi.mock('../../../../../../lib/hospital-dept', () => ({
  requireHospitalStaffContext: async () => h.ctx,
}))

const INVOICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const call = async (id = INVOICE) => {
  const { GET } = await import('./route')
  return GET(new Request(`https://x.test/api/hospital/billing/invoices/${id}`), { params: Promise.resolve({ id }) })
}

afterEach(() => vi.clearAllMocks())

describe('GET /api/hospital/billing/invoices/[id]', () => {
  it('404s for an invoice outside the session tenant', async () => {
    h.ctx = staff('cashier', TENANT_B)
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({ billing_invoices: { data: null, error: null } })
    const res = await call()
    expect(res.status).toBe(404)
    expect(h.db.eqs('billing_invoices')).toEqual(expect.arrayContaining([['tenant_id', TENANT_B], ['id', INVOICE]]))
  })

  it('404s without querying for a non-uuid id', async () => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({})
    expect((await call('1 or 1=1')).status).toBe(404)
    expect(h.db.calls).toHaveLength(0)
  })

  it('returns lines, payments, patient and active policies, all tenant-filtered', async () => {
    h.ctx = staff('cashier', TENANT_A)
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({
      billing_invoices: {
        data: { id: INVOICE, status: 'issued', currency: 'UGX', total_amount: 50000, paid_amount: 5000, insurance_cover_amount: 30000, patient_id: 'p1', encounter_id: 'e1' },
        error: null,
      },
      billing_line_items: { data: [{ id: 'l1', item_name: 'OPD Consultation', total_price: 50000 }], error: null },
      billing_payments: { data: [{ id: 'pay1', amount: 5000 }], error: null },
      patients: { data: { id: 'p1', full_name: 'Nakato Sarah', mrn: 'A-1', phone: '0772' }, error: null },
      insurance_policies: { data: [{ id: 'pol1', payer_id: 'ins1', policy_number: 'JUB-1', member_id: 'JUB-1', plan_name: 'Corporate' }], error: null },
      insurance_providers: { data: [{ id: 'ins1', name: 'Jubilee Health' }], error: null },
    })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.invoice.balance_due).toBe(15000)
    expect(body.lineItems).toHaveLength(1)
    expect(body.payments).toHaveLength(1)
    expect(body.patient.fullName).toBe('Nakato Sarah')
    expect(body.policies).toEqual([{ id: 'pol1', insurerName: 'Jubilee Health', memberNumber: 'JUB-1', scheme: 'Corporate', expiryDate: null }])
    for (const table of ['billing_invoices', 'billing_line_items', 'billing_payments', 'patients', 'insurance_policies', 'insurance_providers']) {
      expect(h.db.eqs(table), table).toContainEqual(['tenant_id', TENANT_A])
    }
  })
})
