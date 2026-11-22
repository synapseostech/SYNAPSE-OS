import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { callsOf, dbMock } from '../../../../../lib/lab/testing/db-mock'

const state = vi.hoisted(() => ({ db: null as unknown as { from: unknown }, cap: null as Response | null }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/hospital-dept', () => ({ requireHospitalStaffContext: async () => ({ userId: 'u1', tenantId: 'tenant-a', hospitalId: 'hosp-a', role: 'doctor' }) }))
vi.mock('@/lib/hospital-shared', () => ({ isContextError: (v: unknown) => v instanceof NextResponse, requireHospitalCapability: async () => state.cap, gateHospitalModule: async () => null }))

import { GET } from './route'

describe('GET /api/hospital/reports/surveillance', () => {
  beforeEach(() => { vi.clearAllMocks(); state.cap = null })

  it('returns weekly series, an immediate cholera alert and districts, tenant-scoped, without identifiers', async () => {
    const now = new Date().toISOString()
    const m = dbMock({
      tables: {
        encounters: { data: [{ id: 'enc-1', visit_date: now, patients: { dob: '1990-01-01', sex: 'F', district: 'Arua' } }] },
        encounter_diagnoses: { data: [{ encounter_id: 'enc-1', stem_code: '1A00', certainty: 'suspected' }] },
      },
    })
    state.db = m.db
    const res = await GET(new NextRequest('http://localhost/api/hospital/reports/surveillance?weeks=8'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.weeks).toHaveLength(8)
    expect(body.alerts[0]).toMatchObject({ key: 'cholera', level: 'immediate' })
    expect(body.districts[0].district).toBe('Arua')
    expect(callsOf(m.tableCalls.encounters![0], 'eq')).toEqual(expect.arrayContaining([['tenant_id', 'tenant-a'], ['hospital_id', 'hosp-a']]))
    expect(JSON.stringify(body)).not.toContain('enc-1')
  })

  it('clamps weeks and refuses without the capability', async () => {
    state.db = dbMock({ tables: { encounters: { data: [] }, encounter_diagnoses: { data: [] } } }).db
    const body = await (await GET(new NextRequest('http://localhost/api/hospital/reports/surveillance?weeks=999'))).json()
    expect(body.weeks).toHaveLength(52)
    state.cap = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await GET(new NextRequest('http://localhost/api/hospital/reports/surveillance'))).status).toBe(403)
  })
})
