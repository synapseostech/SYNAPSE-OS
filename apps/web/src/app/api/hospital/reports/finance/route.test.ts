import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { callsOf, dbMock } from '../../../../../lib/lab/testing/db-mock'

const state = vi.hoisted(() => ({ db: null as unknown as { from: unknown }, cap: null as Response | null, asked: [] as unknown[] }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/hospital-dept', () => ({ requireHospitalStaffContext: async () => ({ userId: 'u1', tenantId: 'tenant-a', hospitalId: 'hosp-a', role: 'hospital_admin' }) }))
vi.mock('@/lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: async (...args: unknown[]) => { state.asked.push(args.slice(1)); return state.cap },
}))

import { GET } from './route'

describe('GET /api/hospital/reports/finance', () => {
  beforeEach(() => { vi.clearAllMocks(); state.cap = null; state.asked = [] })

  it('needs reports.generate.read and filters every table by tenant', async () => {
    const m = dbMock({
      tables: {
        billing_invoices: { data: [{ id: 'i1', status: 'issued', total_amount: 10000, paid_amount: 0, insurance_cover_amount: 0, currency: 'UGX', created_at: '2026-11-02T08:00:00Z' }] },
        billing_payments: { data: [] },
        insurance_claims: { data: [] },
        billing_line_items: { data: [{ invoice_id: 'i1', item_name: 'Consultation', total_price: 10000 }] },
      },
    })
    state.db = m.db
    const res = await GET(new NextRequest('http://localhost/api/hospital/reports/finance?period=202611'))
    expect(res.status).toBe(200)
    expect(state.asked).toEqual([['generate', 'read', 'reports']])
    for (const t of ['billing_invoices', 'billing_payments', 'insurance_claims', 'billing_line_items']) {
      for (const calls of m.tableCalls[t] ?? []) expect(callsOf(calls, 'eq')).toContainEqual(['tenant_id', 'tenant-a'])
    }
    const body = await res.json()
    expect(body.topServices[0].item).toBe('Consultation')
  })

  it('rejects a bad period and a caller without the capability', async () => {
    state.db = dbMock().db
    expect((await GET(new NextRequest('http://localhost/api/hospital/reports/finance?period=11-2026'))).status).toBe(400)
    state.cap = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await GET(new NextRequest('http://localhost/api/hospital/reports/finance'))).status).toBe(403)
  })
})
