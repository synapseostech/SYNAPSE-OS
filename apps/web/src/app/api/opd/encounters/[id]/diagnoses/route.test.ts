import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { createMemoryDb } from '../../../../../../test-utils/memory-postgrest'

const state = vi.hoisted(() => ({ db: null as any, cap: null as Response | null }))

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: { from: (table: string) => state.db.from(table) },
}))
vi.mock('@/lib/hospital-dept', () => ({
  requireHospitalStaffContext: async () => ({
    userId: '00000000-0000-4000-8000-0000000000c1',
    tenantId: '00000000-0000-4000-8000-0000000000t1',
    hospitalId: '00000000-0000-4000-8000-0000000000h1',
    role: 'doctor',
  }),
}))
vi.mock('@/lib/hospital-shared', () => ({
  isContextError: (value: unknown) => value instanceof NextResponse,
  requireHospitalCapability: async () => state.cap,
  gateHospitalModule: async () => null,
  logHospitalAudit: async () => undefined,
}))

import { DELETE, GET, POST } from './route'

const ENCOUNTER = '00000000-0000-4000-8000-0000000000e1'
const TENANT = '00000000-0000-4000-8000-0000000000t1'
const HOSPITAL = '00000000-0000-4000-8000-0000000000h1'
const OTHER_HOSPITAL_ENCOUNTER = '00000000-0000-4000-8000-0000000000e2'

function seed() {
  state.cap = null
  state.db = createMemoryDb({
    encounters: [
      { id: ENCOUNTER, tenant_id: TENANT, hospital_id: HOSPITAL, patient_id: '00000000-0000-4000-8000-0000000000p1', is_signed: false },
      { id: OTHER_HOSPITAL_ENCOUNTER, tenant_id: TENANT, hospital_id: '00000000-0000-4000-8000-0000000000h2', patient_id: '00000000-0000-4000-8000-0000000000p2', is_signed: false },
    ],
    encounter_diagnoses: [],
  })
}

describe('encounter ICD-11 diagnosis', () => {
  beforeEach(seed)

  it('persists a cache selection and reloads it without a duplicate row', async () => {
    const post = await POST(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify({ stem_code: '1F40' }) }), { params: Promise.resolve({ id: ENCOUNTER }) })
    expect(post.status).toBe(201)
    const created = await post.json()
    expect(created.diagnosis.stem_code).toBe('1F40')
    expect(created.diagnosis.title).toMatch(/Malaria/i)
    expect(created.diagnosis.tenant_id).toBe(TENANT)
    expect(created.idempotent).toBe(false)

    const again = await POST(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify({ stem_code: '1F40' }) }), { params: Promise.resolve({ id: ENCOUNTER }) })
    expect(again.status).toBe(200)
    expect((await again.json()).idempotent).toBe(true)
    expect(state.db.tables.encounter_diagnoses).toHaveLength(1)

    const listed = await GET(new NextRequest('http://localhost/api'), { params: Promise.resolve({ id: ENCOUNTER }) })
    const body = await listed.json()
    expect(body.diagnoses.map((row: { stem_code: string }) => row.stem_code)).toEqual(['1F40'])
  })

  it('does not persist an invented code or a reception denial', async () => {
    const unknown = await POST(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify({ stem_code: 'ZZZZ' }) }), { params: Promise.resolve({ id: ENCOUNTER }) })
    expect(unknown.status).toBe(422)
    state.cap = NextResponse.json({ error: 'forbidden' }, { status: 403 })
    const denied = await POST(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify({ stem_code: '1F40' }) }), { params: Promise.resolve({ id: ENCOUNTER }) })
    expect(denied.status).toBe(403)
    expect(state.db.tables.encounter_diagnoses).toHaveLength(0)
  })

  it('hides encounters from another hospital in the same tenant', async () => {
    const params = { params: Promise.resolve({ id: OTHER_HOSPITAL_ENCOUNTER }) }
    const post = await POST(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify({ stem_code: '1F40' }) }), params)
    expect(post.status).toBe(404)
    expect(state.db.tables.encounter_diagnoses).toHaveLength(0)
    const listed = await GET(new NextRequest('http://localhost/api'), { params: Promise.resolve({ id: OTHER_HOSPITAL_ENCOUNTER }) })
    expect(listed.status).toBe(404)
  })
})

describe('full WHO index, certainty and removal', () => {
  beforeEach(seed)
  const post = (body: unknown) =>
    POST(new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: ENCOUNTER }) })

  it('accepts any WHO code, not just the old 17-code seed', async () => {
    const res = await post({ stem_code: 'GC08' })
    expect(res.status).toBe(201)
    expect((await res.json()).diagnosis.title).toBe('Urinary tract infection, site not specified')
  })

  it('refuses a code WHO does not publish', async () => {
    expect((await post({ stem_code: '1E08' })).status).toBe(422)
  })

  it('saves a working diagnosis suggested by the engine, then confirms it in place', async () => {
    const first = await post({ stem_code: '1F40.Z', certainty: 'suspected', suggested_by: 'synapse_intelligence' })
    expect(first.status).toBe(201)
    const row = (await first.json()).diagnosis
    expect(row.certainty).toBe('suspected')
    expect(row.suggested_by).toBe('synapse_intelligence')
    const confirmed = await post({ stem_code: '1F40.Z', certainty: 'confirmed' })
    const body = await confirmed.json()
    expect(confirmed.status, JSON.stringify(body)).toBe(200)
    expect(body.diagnosis?.certainty).toBe('confirmed')
    expect(state.db.tables.encounter_diagnoses).toHaveLength(1)
  })

  it('ignores unknown certainty values', async () => {
    const res = await post({ stem_code: 'BA00', certainty: 'maybe' })
    expect((await res.json()).diagnosis.certainty).toBe('confirmed')
  })

  it('removes a diagnosis as a soft delete', async () => {
    await post({ stem_code: 'GC08' })
    const res = await DELETE(new Request('http://localhost/api?stem_code=GC08', { method: 'DELETE' }), { params: Promise.resolve({ id: ENCOUNTER }) })
    expect(res.status).toBe(200)
    expect((await res.json()).removed).toBe(1)
    expect(state.db.tables.encounter_diagnoses[0].is_deleted).toBe(true)
  })

  it('will not remove from another hospital or a signed encounter', async () => {
    const other = await DELETE(new Request('http://localhost/api?stem_code=GC08', { method: 'DELETE' }), { params: Promise.resolve({ id: OTHER_HOSPITAL_ENCOUNTER }) })
    expect(other.status).toBe(404)
    state.db.tables.encounters[0].is_signed = true
    const signed = await DELETE(new Request('http://localhost/api?stem_code=GC08', { method: 'DELETE' }), { params: Promise.resolve({ id: ENCOUNTER }) })
    expect(signed.status).toBe(409)
  })
})
