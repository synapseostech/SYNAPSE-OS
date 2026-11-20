import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accessState, resetAccess, LAB_TENANT, LAB_HOSPITAL } from '../../../../lib/lab/testing/access-double'
import { callsOf, dbMock } from '../../../../lib/lab/testing/db-mock'

vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ db: null as unknown as { rpc: unknown; from: unknown }, audit: vi.fn(), push: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))
vi.mock('@/lib/lab/access', () => import('../../../../lib/lab/testing/access-double').then((m) => m.accessModule()))
vi.mock('@/lib/lab/engine', () => import('../../../../lib/lab/engine'))
vi.mock('@/lib/lab/label', () => import('../../../../lib/lab/label'))
vi.mock('@/lib/lab/roles', () => import('../../../../lib/lab/roles'))
vi.mock('@/lib/hospital-shared/audit', () => ({ logHospitalAudit: state.audit }))
vi.mock('@synapse/auth/mobile-push', () => ({ notifyPatientLabResult: state.push }))

import { GET as label } from '../orders/[id]/label/route'
import { GET as report } from '../reports/[id]/route'
import { GET as listReports } from '../reports/route'
import { POST as notify } from '../reports/[id]/notify/route'
import { GET as critical } from '../critical/route'
import { POST as criticalAck } from '../results/[id]/critical-ack/route'

const ORDER = 'e76497a1-3a54-4984-827c-f6c339edbf99'
const REPORT = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'
const RESULT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PATIENT = '19bc626f-f51a-4bd5-aefd-7a4534babfeb'
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => { vi.clearAllMocks(); resetAccess() })

function bundle(accession: string | null) {
  return {
    order: { id: ORDER, tenant_id: LAB_TENANT, test_name: 'Blood glucose', urgency: 'STAT', accession_number: accession, section: 'chemistry' },
    results: [], specimen: accession ? { accession_number: accession, specimen_type: 'blood', container: 'Fluoride (grey)', collected_at: '2026-11-21T08:05:00Z' } : null,
    patient: { id: PATIENT, fullName: 'Nakato <Jane>', mrn: 'KLA-1', sex: 'F', dob: '1990-04-02', phone: null, personId: null },
    ranges: [], catalog: null, people: {}, latestReport: null, encounterHospitalId: LAB_HOSPITAL,
  }
}

describe('specimen label', () => {
  it('prints a Code 128 label with patient, test and accession, with a no-script CSP', async () => {
    state.db = dbMock({ rpc: () => ({ data: bundle('LAB-20261121-000001') }) }).db
    const res = await label(new Request(`http://x/api/lab/orders/${ORDER}/label?copies=2`), idParams(ORDER))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['specimen.collect'])
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html.match(/<section class="label">/g)).toHaveLength(2)
    expect(html).toContain('LAB-20261121-000001')
    expect(html).toContain('Nakato &lt;Jane&gt;')
    expect(html).toContain('STAT')
    expect(html).toContain('<svg')
    expect(html).not.toContain('<script')
  })

  it('409 before collection, 404 for another tenant’s order', async () => {
    state.db = dbMock({ rpc: () => ({ data: bundle(null) }) }).db
    expect((await label(new Request('http://x'), idParams(ORDER))).status).toBe(409)
    state.db = dbMock({ rpc: () => ({ data: null }) }).db
    expect((await label(new Request('http://x'), idParams(ORDER))).status).toBe(404)
  })
})

describe('reports', () => {
  it('serves the immutable snapshot for printing, scoped to tenant and facility', async () => {
    const m = dbMock({ tables: { lab_reports: { data: { id: REPORT, html_snapshot: '<html>report</html>', status: 'FINAL' } } } })
    state.db = m.db
    const res = await report(new Request(`http://x/api/lab/reports/${REPORT}?format=html`), idParams(REPORT))
    expect(await res.text()).toBe('<html>report</html>')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(accessState.calls).toEqual(['report.read'])
    expect(callsOf(m.tableCalls.lab_reports![0], 'eq')).toEqual(expect.arrayContaining([['tenant_id', LAB_TENANT], ['facility_id', LAB_HOSPITAL]]))
  })

  it('lists released reports with their deliveries, paged', async () => {
    const m = dbMock({ tables: { lab_reports: { data: [] } } })
    state.db = m.db
    await listReports(new Request('http://x/api/lab/reports?accession=LAB-2026%27);--&limit=500'))
    const calls = m.tableCalls.lab_reports![0]!
    expect(String(callsOf(calls, 'select')[0]![0])).toContain('lab_report_deliveries(')
    expect(callsOf(calls, 'ilike')).toEqual([['accession', 'LAB-2026--%']])
    expect(callsOf(calls, 'limit')).toEqual([[100]])
  })
})

describe('notify a patient that a report is ready', () => {
  function notifyDb(opts: { claimed: Array<{ channel: string; status: string }>; account?: string | null; report?: unknown }) {
    return dbMock({
      tables: {
        lab_reports: { data: opts.report === undefined ? { id: REPORT, version: 1, patient_id: PATIENT } : opts.report },
        patients: { data: { id: PATIENT, phone: '+256772123456', person_id: 'person-1' } },
        persons: { data: { synapse_id: 'SYN-1' } },
        patient_profiles: { data: opts.account === null ? null : { id: opts.account ?? 'acct-1' } },
        lab_report_deliveries: { data: opts.claimed },
      },
    })
  }

  it('claims each channel once, pushes to the patient’s own account, and records SMS as not configured', async () => {
    const m = notifyDb({ claimed: [{ channel: 'push', status: 'SENT' }, { channel: 'sms', status: 'SKIPPED' }] })
    state.db = m.db
    const res = await notify(new Request('http://x', { method: 'POST', body: JSON.stringify({ channels: ['push', 'sms'] }) }), idParams(REPORT))
    expect(res.status).toBe(200)
    expect(accessState.calls).toEqual(['report.notify'])
    const rows = callsOf(m.tableCalls.lab_report_deliveries![0], 'upsert')[0]!
    expect(rows[1]).toEqual({ onConflict: 'report_id,report_version,channel', ignoreDuplicates: true })
    const sms = (rows[0] as Array<Record<string, unknown>>).find((r) => r.channel === 'sms')!
    expect(sms).toMatchObject({ status: 'SKIPPED', detail: 'SMS_PROVIDER_NOT_CONFIGURED', recipient_hint: '•••456', tenant_id: LAB_TENANT })
    expect(state.push).toHaveBeenCalledWith({ userId: 'acct-1' })
  })

  it('a second press sends nothing again', async () => {
    state.db = notifyDb({ claimed: [] }).db
    const res = await notify(new Request('http://x', { method: 'POST', body: JSON.stringify({ channels: ['push'] }) }), idParams(REPORT))
    expect(await res.json()).toMatchObject({ deliveries: [], alreadyDone: ['push'] })
    expect(state.push).not.toHaveBeenCalled()
  })

  it('no app account: push is SKIPPED, nobody is notified', async () => {
    const m = notifyDb({ claimed: [{ channel: 'push', status: 'SKIPPED' }], account: null })
    state.db = m.db
    await notify(new Request('http://x', { method: 'POST', body: JSON.stringify({ channels: ['push'] }) }), idParams(REPORT))
    const row = (callsOf(m.tableCalls.lab_report_deliveries![0], 'upsert')[0]![0] as Array<Record<string, unknown>>)[0]!
    expect(row).toMatchObject({ status: 'SKIPPED', detail: 'PATIENT_HAS_NO_APP_ACCOUNT' })
    expect(state.push).not.toHaveBeenCalled()
  })

  it('404 for another tenant’s report; 400 for unknown channels', async () => {
    state.db = notifyDb({ claimed: [], report: null }).db
    expect((await notify(new Request('http://x', { method: 'POST', body: JSON.stringify({ channels: ['push'] }) }), idParams(REPORT))).status).toBe(404)
    expect((await notify(new Request('http://x', { method: 'POST', body: JSON.stringify({ channels: ['fax'] }) }), idParams(REPORT))).status).toBe(400)
  })
})

describe('critical values', () => {
  it('the critical queue lists only unacknowledged critical results of this tenant', async () => {
    const m = dbMock({ tables: { lab_results: { data: [] } } })
    state.db = m.db
    await critical()
    const calls = m.tableCalls.lab_results![0]!
    expect(callsOf(calls, 'eq')).toEqual(expect.arrayContaining([['tenant_id', LAB_TENANT], ['is_critical', true]]))
    expect(callsOf(calls, 'is')).toEqual([['critical_scientist_ack_at', null]])
  })

  it('acknowledgement is one guarded update; a lab admin now counts as lab staff', async () => {
    accessState.ctx.role = 'lab_admin'
    const m = dbMock({ tables: { lab_results: { data: { id: RESULT } } } })
    state.db = m.db
    const res = await criticalAck(new Request('http://x', { method: 'POST', body: '{}' }) as never, idParams(RESULT))
    expect(res.status).toBe(200)
    const calls = m.tableCalls.lab_results![0]!
    expect(Object.keys(callsOf(calls, 'update')[0]![0] as object)).toEqual(['critical_scientist_ack_at', 'critical_scientist_ack_by'])
    expect(callsOf(calls, 'eq')).toEqual(expect.arrayContaining([['tenant_id', LAB_TENANT], ['is_critical', true]]))
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAB_CRITICAL_SCIENTIST_ACK' }))
  })

  it('a clinician acknowledges on the clinician columns; other roles are refused; a non-critical result is 404', async () => {
    accessState.ctx.role = 'doctor'
    const m = dbMock({ tables: { lab_results: { data: null } } })
    state.db = m.db
    expect((await criticalAck(new Request('http://x', { method: 'POST' }) as never, idParams(RESULT))).status).toBe(404)
    expect(Object.keys(callsOf(m.tableCalls.lab_results![0], 'update')[0]![0] as object)).toEqual(['critical_clinician_ack_at', 'critical_clinician_ack_by'])
    accessState.ctx.role = 'cashier'
    expect((await criticalAck(new Request('http://x', { method: 'POST' }) as never, idParams(RESULT))).status).toBe(403)
  })
})
