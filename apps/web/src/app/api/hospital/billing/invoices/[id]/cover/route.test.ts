import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createDbMock, HOSPITAL_A, MISSING_RPC, staff, TENANT_A, USER } from '../../../../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({ db: null as never as ReturnType<typeof createDbMock>, ctx: null as unknown, cap: vi.fn(), mod: vi.fn(), audit: vi.fn() }))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../../../../lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: (...a: unknown[]) => h.cap(...a),
  gateHospitalModule: (...a: unknown[]) => h.mod(...a),
  logHospitalAudit: (...a: unknown[]) => h.audit(...a),
}))
vi.mock('../../../../../../../lib/hospital-dept', async () => ({
  ...(await import('../../../../../../../lib/hospital-dept/schemas')),
  ...(await import('../../../../../../../lib/hospital-dept/rpc-errors')),
  requireHospitalStaffContext: async () => h.ctx,
}))

const INVOICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const post = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST(
    new NextRequest(`https://x.test/api/hospital/billing/invoices/${INVOICE}/cover`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: INVOICE }) },
  )
}

afterEach(() => vi.clearAllMocks())

describe('POST /api/hospital/billing/invoices/[id]/cover', () => {
  it('requires billing.insurance.apply', async () => {
    h.ctx = staff('nurse')
    h.db = createDbMock({})
    h.cap.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await post({ cover_amount: 1000, insurer_name: 'Jubilee', member_number: 'J1' })).status).toBe(403)
    expect(h.cap).toHaveBeenCalledWith(expect.anything(), 'insurance', 'apply', 'billing')
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it('needs a policy or insurer + member number', async () => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({})
    expect((await post({ cover_amount: 1000 })).status).toBe(400)
    expect(h.db.rpcCalls).toHaveLength(0)
  })

  it('applies cover in one RPC with tenant, hospital and actor from the session', async () => {
    h.ctx = staff('cashier', TENANT_A)
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({})
    h.db.setRpc('hospital_apply_invoice_cover', { data: { invoiceId: INVOICE, insuranceCover: 30000, claimId: 'c1', policyId: 'pol1', balanceDue: 20000 }, error: null })
    const res = await post({ cover_amount: 30000, insurer_name: 'Jubilee Health', member_number: 'JUB-778', tenant_id: 'ignored' })
    expect(res.status).toBe(200)
    expect(h.db.rpcCalls).toEqual([{
      fn: 'hospital_apply_invoice_cover',
      args: {
        p_tenant_id: TENANT_A, p_hospital_id: HOSPITAL_A, p_invoice_id: INVOICE, p_cover_amount: 30000, p_actor_id: USER,
        p_policy_id: null, p_insurer_name: 'Jubilee Health', p_member_number: 'JUB-778', p_scheme: null,
      },
    }])
    expect((await res.json()).cover.balanceDue).toBe(20000)
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'billing_invoices', recordId: INVOICE }))
  })

  it.each([
    ['COVER_EXCEEDS_BALANCE', 409],
    ['CLAIM_ALREADY_SUBMITTED', 409],
    ['INVOICE_NOT_FOUND', 404],
    ['POLICY_INACTIVE', 422],
  ])('maps %s to %i', async (code, status) => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({})
    h.db.setRpc('hospital_apply_invoice_cover', { data: null, error: { code: 'P0001', message: code } })
    const res = await post({ cover_amount: 0 })
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(code)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('says so when the migration is not applied', async () => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({})
    h.db.setRpc('hospital_apply_invoice_cover', MISSING_RPC)
    expect((await post({ cover_amount: 0 })).status).toBe(503)
  })
})
