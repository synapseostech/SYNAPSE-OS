import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { callsOf, dbMock } from '../../../../../lib/lab/testing/db-mock'

const state = vi.hoisted(() => ({ db: null as unknown as { from: unknown }, cap: null as Response | null }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/hospital-dept', () => ({
  requireHospitalStaffContext: async () => ({ userId: 'u1', tenantId: 'tenant-a', hospitalId: 'hosp-a', role: 'doctor' }),
}))
vi.mock('@/lib/hospital-shared', () => ({
  isContextError: (v: unknown) => v instanceof NextResponse,
  requireHospitalCapability: async () => state.cap,
  gateHospitalModule: async () => null,
}))

import { GET } from './route'

const req = (q: string) => new NextRequest(`http://localhost/api/hospital/reports/hmis105${q}`)

function seed() {
  state.cap = null
  const m = dbMock({
    tables: {
      encounters: { data: [
        { id: 'e1', visit_date: '2026-11-03T08:00:00Z', patients: { dob: '2023-01-01', sex: 'F' } },
        { id: 'e2', visit_date: '2026-11-04T08:00:00Z', patients: { date_of_birth: '1990-01-01', sex: 'M' } },
        { id: 'e3', visit_date: '2026-11-05T08:00:00Z', patients: null },
      ] },
      encounter_diagnoses: { data: [
        { encounter_id: 'e1', stem_code: '1F40.Z', certainty: 'confirmed' },
        { encounter_id: 'e2', stem_code: '1F40.Z', certainty: 'suspected' },
        { encounter_id: 'e2', stem_code: 'CA40.Z', certainty: 'differential' },
        { encounter_id: 'other-tenant-encounter', stem_code: 'BA00', certainty: 'confirmed' },
      ] },
    },
  })
  state.db = m.db
  return m
}

describe('GET /api/hospital/reports/hmis105', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('counts the month by HMIS group, scoped to the tenant and hospital, in Kampala time', async () => {
    const m = seed()
    const res = await GET(req('?period=202611'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const malaria = body.rows.find((r: { key: string }) => r.key === 'malaria_confirmed')
    expect(malaria.total).toBe(2)
    expect(malaria.bands['29d_4y'].F).toBe(1)
    expect(malaria.bands['5_59y'].M).toBe(1)
    expect(body.totals.excludedDifferential).toBe(1)
    expect(body.encountersInPeriod).toBe(3)
    expect(body.totals.cases).toBe(2) // the other tenant's row is not one of this month's encounters

    const enc = m.tableCalls.encounters![0]!
    expect(callsOf(enc, 'eq')).toEqual(expect.arrayContaining([['tenant_id', 'tenant-a'], ['hospital_id', 'hosp-a'], ['is_deleted', false]]))
    expect(callsOf(enc, 'gte')).toEqual([['visit_date', '2026-10-31T21:00:00.000Z']])
    expect(callsOf(enc, 'lt')).toEqual([['visit_date', '2026-11-30T21:00:00.000Z']])
    expect(callsOf(m.tableCalls.encounter_diagnoses![0], 'eq')).toContainEqual(['tenant_id', 'tenant-a'])
    expect(JSON.stringify(body)).not.toMatch(/e1|e2|tenant-a/)
  })

  it('downloads CSV', async () => {
    seed()
    const res = await GET(req('?period=202611&format=csv'))
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('HMIS105-OPD-diagnoses-202611.csv')
    expect(await res.text()).toContain('Malaria (confirmed)')
  })

  it('rejects a bad period and a caller without the capability', async () => {
    seed()
    expect((await GET(req('?period=2026-11'))).status).toBe(400)
    expect((await GET(req('?period=202613'))).status).toBe(400)
    state.cap = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await GET(req('?period=202611'))).status).toBe(403)
  })
})
