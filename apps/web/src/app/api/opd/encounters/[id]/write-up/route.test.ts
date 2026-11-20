import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const {
  requireHospitalStaffContext,
  requireHospitalCapability,
  gateHospitalModule,
  logHospitalAudit,
  dbFrom,
} = vi.hoisted(() => ({
  requireHospitalStaffContext: vi.fn(),
  requireHospitalCapability: vi.fn(),
  gateHospitalModule: vi.fn(),
  logHospitalAudit: vi.fn(),
  dbFrom: vi.fn(),
}))

vi.mock('@/lib/hospital-dept', () => ({
  requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
}))

vi.mock('@/lib/hospital-shared', async () => {
  const { NextResponse } = await import('next/server')
  return {
    isContextError: (value: unknown): value is InstanceType<typeof NextResponse> =>
      value instanceof NextResponse,
    requireHospitalCapability: (...args: unknown[]) => requireHospitalCapability(...args),
    gateHospitalModule: (...args: unknown[]) => gateHospitalModule(...args),
    logHospitalAudit: (...args: unknown[]) => logHospitalAudit(...args),
    hospitalOutboxWrapMaterial: () => 'synthetic-recovery-material',
  }
})

vi.mock('@synapse/db/admin', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const HOSPITAL = '22222222-2222-4222-8222-222222222222'
const ENCOUNTER = '44444444-4444-4444-8444-444444444444'

function staffCtx() {
  return {
    userId: '55555555-5555-4555-8555-555555555555',
    email: 'doc@example.test',
    role: 'doctor',
    tenantId: TENANT,
    hospitalId: HOSPITAL,
    facilityType: 'hospital',
    fullName: 'Dr Test',
  }
}

function tableMock(handlers: Record<string, { data?: unknown; error?: unknown; onUpdate?: (p: unknown) => void }>) {
  return (table: string) => {
    const handler = handlers[table] ?? { data: null, error: null }
    const api: Record<string, unknown> = {}
    const self = () => api
    for (const method of ['select', 'eq', 'not', 'in', 'limit']) api[method] = vi.fn(self)
    api.update = vi.fn((payload: unknown) => {
      handler.onUpdate?.(payload)
      return api
    })
    api.maybeSingle = vi.fn(async () => ({
      data: Array.isArray(handler.data) ? null : handler.data ?? null,
      error: handler.error ?? null,
    }))
    api.then = (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: handler.data ?? null, error: handler.error ?? null }).then(resolve, reject)
    return api
  }
}

describe('opd encounter write-up route', () => {
  beforeEach(() => {
    requireHospitalCapability.mockResolvedValue(null)
    gateHospitalModule.mockResolvedValue(null)
    logHospitalAudit.mockResolvedValue(undefined)
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('GET returns structured writeup from metadata', async () => {
    dbFrom.mockImplementation(
      tableMock({
        encounters: {
          data: {
            id: ENCOUNTER,
            patient_id: 'pat-1',
            is_signed: false,
            chief_complaint: 'Fever',
            status: 'open',
            metadata: { writeup: { hpi: '2 days fever', plan: 'labs' } },
          },
        },
      }),
    )
    const { GET } = await import('./route')
    const res = await GET(new Request('https://synapseos.tech/api/opd/encounters/x/write-up'), {
      params: Promise.resolve({ id: ENCOUNTER }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('vary')).toBe('Cookie, Authorization')
    expect(body.writeup.hpi).toBe('2 days fever')
    expect(body.completeness.filled).toBeGreaterThan(0)
  })

  it('PUT rejects signed encounters', async () => {
    dbFrom.mockImplementation(
      tableMock({
        encounters: {
          data: {
            id: ENCOUNTER,
            patient_id: 'pat-1',
            is_signed: true,
            chief_complaint: 'Fever',
            status: 'signed',
            metadata: {},
          },
        },
      }),
    )
    const { PUT } = await import('./route')
    const res = await PUT(
      new NextRequest('https://synapseos.tech/api/opd/encounters/x/write-up', {
        method: 'PUT',
        body: JSON.stringify({ hpi: 'updated' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: ENCOUNTER }) },
    )
    expect(res.status).toBe(409)
  })

  it('PUT stores tapped findings (known ids only) and the differential snapshot', async () => {
    let updated: Record<string, unknown> | null = null
    dbFrom.mockImplementation(
      tableMock({
        encounters: {
          data: { id: ENCOUNTER, patient_id: 'pat-1', is_signed: false, chief_complaint: 'Fever', status: 'in_progress', metadata: {} },
          onUpdate: (payload) => {
            updated = payload as Record<string, unknown>
          },
        },
      }),
    )
    const { PUT } = await import('./route')
    const res = await PUT(
      new NextRequest('https://synapseos.tech/api/opd/encounters/x/write-up', {
        method: 'PUT',
        body: JSON.stringify({
          hpi: 'Fever 3 days',
          findings: { fever: 'present', cough: 'absent', not_a_finding: 'present' },
          differential: [{ id: 'malaria', code: '1F40.Z', score: 11 }],
        }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: ENCOUNTER }) },
    )
    expect(res.status).toBe(200)
    const meta = (updated as unknown as { metadata: Record<string, any> }).metadata
    expect(meta.consultation.findings).toEqual({ fever: 'present', cough: 'absent' })
    expect(meta.consultation.differential).toEqual([{ id: 'malaria', code: '1F40.Z', score: 11 }])
    expect(meta.consultation.engine).toMatch(/^ug-opd\./)
    expect(meta.writeup.hpi).toBe('Fever 3 days')
    expect(meta.writeup).not.toHaveProperty('findings')
  })

  it('PUT merges writeup into metadata and syncs clinical_note', async () => {
    let updated: Record<string, unknown> | null = null
    dbFrom.mockImplementation(
      tableMock({
        encounters: {
          data: {
            id: ENCOUNTER,
            patient_id: 'pat-1',
            is_signed: false,
            chief_complaint: 'Fever',
            status: 'open',
            metadata: { triage: { esi: 3 } },
          },
          onUpdate: (payload) => {
            updated = payload as Record<string, unknown>
          },
        },
      }),
    )
    const { PUT } = await import('./route')
    const res = await PUT(
      new NextRequest('https://synapseos.tech/api/opd/encounters/x/write-up', {
        method: 'PUT',
        body: JSON.stringify({ hpi: '2d fever', assessment: 'viral illness', plan: 'supportive' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: ENCOUNTER }) },
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.writeup.hpi).toBe('2d fever')
    expect(body.clinicalNote).toContain('HPI')
    expect(updated).toBeTruthy()
    const meta = updated!.metadata as {
      triage: { esi: number }
      writeup: { hpi: string }
      clinical_note: string
    }
    expect(meta.triage).toEqual({ esi: 3 })
    expect(meta.writeup.hpi).toBe('2d fever')
    expect(meta.clinical_note).toContain('Fever')
  })
})
