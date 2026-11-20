import { describe, expect, it, vi } from 'vitest'
import { callsOf, dbMock } from './testing/db-mock'

vi.mock('server-only', () => ({}))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: {} }))

import { decodeCursor, encodeCursor, fetchLabWorklist, LAB_VIEWS } from './worklist'

const TENANT = '0edb651a-232a-4289-9b3d-ae5bb1bac2cb'
const ctx = { userId: 'u', email: '', role: 'lab_tech', tenantId: TENANT, hospitalId: 'h', facilityType: 'laboratory', fullName: null }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: id(100 - i), tenant_id: TENANT, encounter_id: 'e', patient_id: 'p', loinc_code: '2345-7', test_name: 'Glucose',
    section: 'chemistry', urgency: 'ROUTINE', workflow_status: 'RECEIVED', order_source: 'walk_in', accession_number: `LAB-${i}`,
    specimen_id: null, ordered_at: new Date(Date.UTC(2026, 10, 21, 10, 0, 0) - i * 60_000).toISOString(),
    patients: { full_name: ' Kato Synthetic ', mrn: 'KLA-1', sex: 'M', dob: '1980-01-01' },
    lab_results: i === 0 ? [{ id: 'r', result_value: '28', unit: 'mmol/L', reference_range: '4–7', abnormal_flag: 'CRIT', is_critical: true, critical_scientist_ack_at: null }] : [],
  }))
}

describe('fetchLabWorklist', () => {
  it('is one tenant-scoped query embedding only real patient columns and the result', async () => {
    const m = dbMock({ tables: { lab_orders: { data: rows(3) } } })
    const res = await fetchLabWorklist(ctx, {}, m.db)
    expect(m.from).toHaveBeenCalledTimes(1)
    const calls = m.tableCalls.lab_orders![0]!
    const select = String(callsOf(calls, 'select')[0]![0])
    expect(select).toMatch(/patients\(full_name, mrn, sex, dob\)/)
    expect(select).not.toMatch(/first_name|last_name|date_of_birth/)
    expect(select).toMatch(/lab_results\(/)
    expect(callsOf(calls, 'eq')).toContainEqual(['tenant_id', TENANT])
    expect(callsOf(calls, 'eq')).toContainEqual(['is_synthetic', false])
    expect(res.orders[0]).toMatchObject({ patientName: 'Kato Synthetic', isCritical: true, resultValue: '28', section: 'chemistry' })
    expect(res.nextCursor).toBeNull()
  })

  it('filters by section and bench view', async () => {
    const m = dbMock({ tables: { lab_orders: { data: [] } } })
    await fetchLabWorklist(ctx, { section: 'haematology', view: 'bench' }, m.db)
    const calls = m.tableCalls.lab_orders![0]!
    expect(callsOf(calls, 'eq')).toContainEqual(['section', 'haematology'])
    expect(callsOf(calls, 'in')).toContainEqual(['workflow_status', [...LAB_VIEWS.bench]])
  })

  it('ignores an unknown section instead of passing it to the database', async () => {
    const m = dbMock({ tables: { lab_orders: { data: [] } } })
    await fetchLabWorklist(ctx, { section: 'x);drop' }, m.db)
    expect(callsOf(m.tableCalls.lab_orders![0], 'eq').some((c) => c[0] === 'section')).toBe(false)
  })

  it('pages with a keyset cursor: fetches limit+1 and returns the cursor of the last row shown', async () => {
    const m = dbMock({ tables: { lab_orders: { data: rows(11) } } })
    const res = await fetchLabWorklist(ctx, { limit: 10 }, m.db)
    expect(callsOf(m.tableCalls.lab_orders![0], 'limit')).toEqual([[11]])
    expect(res.orders).toHaveLength(10)
    const cursor = decodeCursor(res.nextCursor)
    expect(cursor?.id).toBe(res.orders[9]!.id)
    const m2 = dbMock({ tables: { lab_orders: { data: [] } } })
    await fetchLabWorklist(ctx, { cursor: res.nextCursor, limit: 10 }, m2.db)
    const or = String(callsOf(m2.tableCalls.lab_orders![0], 'or')[0]![0])
    expect(or).toBe(`ordered_at.lt.${cursor!.orderedAt},and(ordered_at.eq.${cursor!.orderedAt},id.lt.${cursor!.id})`)
  })

  it('rejects tampered cursors', () => {
    expect(decodeCursor('garbage')).toBeNull()
    expect(decodeCursor(Buffer.from('2026-01-01|not-a-uuid').toString('base64url'))).toBeNull()
    expect(decodeCursor(encodeCursor('2026-11-21T10:00:00.000Z', id(1)))).toEqual({ orderedAt: '2026-11-21T10:00:00.000Z', id: id(1) })
  })

  it('looks an accession up on the order, a name up on the patient, and falls back to patient number', async () => {
    const byAccession = dbMock({ tables: { lab_orders: { data: rows(1) } } })
    await fetchLabWorklist(ctx, { q: 'LAB-20261121-000001' }, byAccession.db)
    expect(callsOf(byAccession.tableCalls.lab_orders![0], 'ilike')).toEqual([['accession_number', 'LAB-20261121-000001%']])

    const byName = dbMock({ tables: { lab_orders: { data: [] } } })
    await fetchLabWorklist(ctx, { q: 'Nakato, Jane)' }, byName.db)
    const or = callsOf(byName.tableCalls.lab_orders![0], 'or')[0]!
    expect(or[0]).toBe('full_name.ilike.%Nakato Jane%,mrn.ilike.Nakato Jane%')
    expect(or[1]).toEqual({ referencedTable: 'patients' })
    expect(String(callsOf(byName.tableCalls.lab_orders![0], 'select')[0]![0])).toMatch(/patients!inner/)

    const fallback = dbMock({ tables: { lab_orders: { data: [] } } })
    await fetchLabWorklist(ctx, { q: 'KLA-123' }, fallback.db)
    expect(fallback.from).toHaveBeenCalledTimes(2)
    expect(callsOf(fallback.tableCalls.lab_orders![1], 'ilike')).toEqual([['patients.mrn', 'KLA-123%']])
  })
})
