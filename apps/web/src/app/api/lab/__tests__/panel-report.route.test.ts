import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess, LAB_TENANT } from '../../../../lib/lab/testing/access-double'
import { callsOf, dbMock } from '../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as { rpc: unknown; from: unknown } }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/lab/label', () => import('../../../../lib/lab/label'))

import { GET } from '../orders/[id]/panel-report/route'

const PANEL = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { vi.clearAllMocks(); resetAccess() })

function panelDb(order: Record<string, unknown> | null) {
  let orderCalls = 0
  const m = dbMock({
    tables: {
      lab_orders: () => (orderCalls++ === 0
        ? { data: order }
        : { data: [
          { id: 'c1', test_name: 'Haemoglobin', loinc_code: '718-7', workflow_status: 'RELEASED', verified_by: 'u-sci', lab_results: [{ result_value: '9.1', unit: 'g/dL', reference_range: '13.0–17.0', abnormal_flag: 'L', is_critical: false, version: 1 }] },
          { id: 'c2', test_name: 'Platelet count', loinc_code: '777-3', workflow_status: 'RESULT_ENTERED', verified_by: null, lab_results: [{ result_value: '999999', version: 1 }] },
        ] }),
      lab_specimens: { data: { specimen_type: 'blood', collected_at: '2026-11-22T08:05:00Z', received_at: '2026-11-22T08:20:00Z' } },
      profiles: { data: [{ id: 'u-sci', full_name: 'Sarah Okello' }] },
    },
  })
  state.db = m.db
  return m
}

describe('GET /api/lab/orders/[id]/panel-report', () => {
  it('prints authorised component results, hides unauthorised values, tenant-scoped', async () => {
    const m = panelDb({ id: PANEL, test_name: 'Full blood count', panel_code: 'FBC', panel_order_id: null, accession_number: 'LAB-20261122-000009', specimen_id: 's1', patients: { full_name: 'Demo Okello', mrn: 'KLA-1', sex: 'M', dob: '1985-01-01' } })
    const res = await GET(new Request('http://x'), params(PANEL))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['report.read'])
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain('9.1')
    expect(html).toContain('Pending authorisation')
    expect(html).not.toContain('999999')
    expect(html).toContain('Sarah Okello')
    for (const t of ['lab_orders', 'lab_specimens', 'profiles']) {
      for (const calls of m.tableCalls[t] ?? []) expect(callsOf(calls, 'eq')).toContainEqual(['tenant_id', LAB_TENANT])
    }
  })

  it('404s an ordinary test or a component, and 409s an uncollected panel', async () => {
    panelDb({ id: PANEL, test_name: 'Blood glucose', panel_code: null, panel_order_id: null, accession_number: 'X' })
    expect((await GET(new Request('http://x'), params(PANEL))).status).toBe(404)
    panelDb({ id: PANEL, test_name: 'Haemoglobin', panel_code: 'FBC', panel_order_id: 'other', accession_number: 'X' })
    expect((await GET(new Request('http://x'), params(PANEL))).status).toBe(404)
    panelDb({ id: PANEL, test_name: 'Full blood count', panel_code: 'FBC', panel_order_id: null, accession_number: null })
    expect((await GET(new Request('http://x'), params(PANEL))).status).toBe(409)
    expect((await GET(new Request('http://x'), params('nope'))).status).toBe(404)
  })

  it('needs lab.report.read', async () => {
    accessState.deny = () => 403
    panelDb(null)
    expect((await GET(new Request('http://x'), params(PANEL))).status).toBe(403)
  })
})
