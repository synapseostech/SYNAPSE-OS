import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createDbMock, staff, TENANT_A } from '../../../../../test-utils/hospital-route-mocks'

const h = vi.hoisted(() => ({ db: null as never as ReturnType<typeof createDbMock>, ctx: null as unknown, cap: vi.fn(), mod: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, key) => (h.db as unknown as Record<string, unknown>)[key as string] }),
}))
vi.mock('../../../../../lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: (...a: unknown[]) => h.cap(...a),
  gateHospitalModule: (...a: unknown[]) => h.mod(...a),
}))
vi.mock('../../../../../lib/hospital-dept', async () => ({
  ...(await import('../../../../../lib/hospital-dept/schemas')),
  requireHospitalStaffContext: async () => h.ctx,
}))

const url = (qs = '') => new NextRequest(`https://clinic.synapseos.tech/api/hospital/billing/invoices${qs}`)
const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `inv-${i}`, invoice_number: `INV-${i}`, status: 'issued', currency: 'UGX', total_amount: 50000, paid_amount: 10000,
  insurance_cover_amount: 30000, encounter_id: `enc-${i}`, patient_id: `p-${i}`, created_at: `2026-11-20T08:0${i}:00Z`,
  patients: { full_name: `Patient ${i}`, mrn: `M-${i}` }, ...extra,
})

afterEach(() => vi.clearAllMocks())

describe('GET /api/hospital/billing/invoices (cashier queue)', () => {
  it('requires billing.invoice.read and the billing module', async () => {
    h.ctx = staff('receptionist')
    h.db = createDbMock({})
    h.cap.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    const { GET } = await import('./route')
    expect((await GET(url())).status).toBe(403)
    expect(h.cap).toHaveBeenCalledWith(expect.anything(), 'invoice', 'read', 'billing')
    expect(h.db.calls).toHaveLength(0)
  })

  it('lists open invoices of the session tenant in one query with the patient share due', async () => {
    h.ctx = staff('cashier', TENANT_A)
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({ billing_invoices: { data: [row(3), row(2), row(1)], error: null } })
    const { GET } = await import('./route')
    const res = await GET(url('?limit=2'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(h.db.calls).toHaveLength(1)
    expect(h.db.eqs('billing_invoices')).toContainEqual(['tenant_id', TENANT_A])
    const ops = h.db.calls[0].ops
    expect(ops).toContainEqual(['in', ['status', ['draft', 'issued', 'partially_paid']]])
    expect(ops).toContainEqual(['limit', [3]])
    expect(body.invoices).toHaveLength(2)
    expect(body.invoices[0]).toMatchObject({ id: 'inv-3', patientName: 'Patient 3', mrn: 'M-3', insuranceCover: 30000, balanceDue: 10000 })
    expect(body.nextBefore).toBe('2026-11-20T08:02:00Z')
  })

  it('pages with before= and reports no next page at the end', async () => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({ billing_invoices: { data: [row(1)], error: null } })
    const { GET } = await import('./route')
    const body = await (await GET(url('?before=2026-11-20T08:02:00Z&status=all'))).json()
    expect(h.db.calls[0].ops).toContainEqual(['lt', ['created_at', '2026-11-20T08:02:00Z']])
    expect(h.db.calls[0].ops.some(([op]) => op === 'in')).toBe(false)
    expect(body.nextBefore).toBeNull()
  })

  it('works before the insurance columns exist', async () => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({
      billing_invoices: [
        { data: null, error: { code: '42703', message: 'column insurance_cover_amount does not exist' } },
        { data: [row(1, { insurance_cover_amount: undefined })], error: null },
      ],
    })
    const { GET } = await import('./route')
    const body = await (await GET(url())).json()
    expect(body.invoices[0].balanceDue).toBe(40000)
  })

  it('rejects a malformed page cursor', async () => {
    h.ctx = staff('cashier')
    h.cap.mockResolvedValue(null)
    h.mod.mockResolvedValue(null)
    h.db = createDbMock({})
    const { GET } = await import('./route')
    expect((await GET(url('?before=yesterday'))).status).toBe(400)
  })
})
