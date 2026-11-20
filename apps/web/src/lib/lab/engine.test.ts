import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dbMock, callsOf } from './testing/db-mock'

vi.mock('server-only', () => ({}))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: {} }))
const persist = vi.hoisted(() => ({
  events: vi.fn(async () => ({ ok: true })),
  artifacts: vi.fn(async () => ({ errors: [] as string[] })),
  timeline: vi.fn(),
}))
vi.mock('@synapse/db/work-queue-persist', async (orig) => ({
  ...(await orig<typeof import('@synapse/db/work-queue-persist')>()),
  persistDomainEventsBestEffort: persist.events,
  persistWorkQueueArtifactsBestEffort: persist.artifacts,
}))
vi.mock('@synapse/db/clinical-timeline', async (orig) => ({
  ...(await orig<typeof import('@synapse/db/clinical-timeline')>()),
  publishClinicalTimelineBestEffort: persist.timeline,
}))
vi.mock('@synapse/db/identity-persist', () => ({ publishTimelineEvent: vi.fn() }))

import { runLabAction, LabActionError } from './engine'

const TENANT = '0edb651a-232a-4289-9b3d-ae5bb1bac2cb'
const OTHER_TENANT = '200dfeb5-4c09-4a5d-8d46-14aa4b78a6ec'
const HOSPITAL = '7a0c4a2e-1111-4aaa-8aaa-000000000001'
const ORDER = 'e76497a1-3a54-4984-827c-f6c339edbf99'
const PATIENT = '19bc626f-f51a-4bd5-aefd-7a4534babfeb'
const ENCOUNTER = 'e6edbd38-08be-4f07-aeff-3ad268e939fe'
const SPECIMEN = '206d336c-1a15-413e-ac00-e8af92180ce1'
const TECH = '81456280-e996-4ff3-84ba-cada261d5061'
const SCIENTIST = '91456280-e996-4ff3-84ba-cada261d5062'
const RESULT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ctx = (userId = SCIENTIST, role = 'lab_scientist') => ({
  userId, email: 'x@test', role, tenantId: TENANT, hospitalId: HOSPITAL, facilityType: 'laboratory',
  fullName: userId === SCIENTIST ? 'Sarah Okello' : 'Tom Tech', facilityName: 'Kampala Diagnostics',
})

function orderRow(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER, tenant_id: TENANT, encounter_id: ENCOUNTER, patient_id: PATIENT, person_id: null,
    loinc_code: '2345-7', test_name: 'Blood glucose', urgency: 'ROUTINE', workflow_status: status,
    ordered_by: TECH, ordered_at: '2026-11-21T08:00:00.000Z', correlation_id: ENCOUNTER,
    accession_number: status === 'ORDERED' ? null : 'LAB-20261121-000001', barcode: null,
    specimen_id: status === 'ORDERED' ? null : SPECIMEN, is_synthetic: false, section: 'chemistry',
    order_source: 'walk_in', referral_source: 'Dr Okello', ...overrides,
  }
}

function resultRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESULT, tenant_id: TENANT, lab_order_id: ORDER, patient_id: PATIENT, loinc_code: '2345-7',
    test_name: 'Blood glucose', result_value: '6.5', unit: 'mmol/L', reference_range: '4–7 mmol/L',
    status: 'preliminary', is_critical: false, is_abnormal: false, abnormal_flag: 'N', version: 1,
    provenance: 'SYSTEM_GENERATED', is_synthetic: false, entered_by: TECH, ...overrides,
  }
}

function bundle(status: string, opts: { order?: Record<string, unknown>; results?: Record<string, unknown>[]; ranges?: unknown[] } = {}) {
  return {
    order: orderRow(status, opts.order),
    results: opts.results ?? [],
    specimen: status === 'ORDERED' ? null : { id: SPECIMEN, specimen_type: 'blood', collected_at: '2026-11-21T08:05:00Z', received_at: '2026-11-21T08:20:00Z' },
    patient: { id: PATIENT, fullName: 'Nakato Jane', mrn: 'KLA-1', sex: 'F', dob: '1990-04-02', phone: '0772000111', personId: null },
    encounterHospitalId: HOSPITAL,
    ranges: opts.ranges ?? [{ tenant_id: TENANT, loinc_code: '2345-7', test_name: 'Glucose', unit: 'mmol/L', low: 4, high: 7, critical_low: 2.5, critical_high: 25 }],
    catalog: { id: 'cat-1', code: 'GLU', unit: 'mmol/L', specimen_type: 'blood', container: 'Fluoride (grey)' },
    people: { [TECH]: 'Tom Tech', [SCIENTIST]: 'Sarah Okello' },
    latestReport: null,
  }
}

function setup(b: unknown, commit: { data?: unknown; error?: { message?: string; code?: string } | null } = { data: { orderStatus: 'X', reportId: 'rep-1' } }, tables = {}) {
  const commits: Record<string, unknown>[] = []
  const m = dbMock({
    rpc: (fn, args) => {
      if (fn === 'lab_order_bundle') return { data: b }
      if (fn === 'lab_commit_action') { commits.push(args.p as Record<string, unknown>); return commit }
      if (fn === 'allocate_lab_accession') return { data: 'LAB-20261121-000007' }
      return { data: null }
    },
    tables,
  })
  return { ...m, commits }
}

beforeEach(() => vi.clearAllMocks())

describe('runLabAction: one read, one write', () => {
  it('loads the order through lab_order_bundle scoped to the caller tenant and hospital', async () => {
    const m = setup(bundle('RECEIVED'))
    await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'enter_result', extra: { value: '6.5' }, db: m.db })
    expect(m.rpc).toHaveBeenCalledWith('lab_order_bundle', { p_tenant_id: TENANT, p_order_id: ORDER, p_hospital_id: HOSPITAL })
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual(['lab_order_bundle', 'lab_commit_action'])
    expect(m.from).not.toHaveBeenCalled()
  })

  it('does not act on another tenant order even if the loader returned one', async () => {
    const m = setup({ ...bundle('RECEIVED'), order: orderRow('RECEIVED', { tenant_id: OTHER_TENANT }) })
    await expect(runLabAction({ ctx: ctx(), orderId: ORDER, action: 'verify', db: m.db })).rejects.toMatchObject({ code: 'LAB_ORDER_NOT_FOUND', status: 404 })
    expect(m.commits).toHaveLength(0)
  })

  it('404s a malformed id without calling the database', async () => {
    const m = setup(null)
    await expect(runLabAction({ ctx: ctx(), orderId: 'not-a-uuid', action: 'verify', db: m.db })).rejects.toMatchObject({ status: 404 })
    expect(m.rpc).not.toHaveBeenCalled()
  })

  it('enter_result commits order + result + audit together, guarded by the loaded status, and flags with the lab range', async () => {
    const m = setup(bundle('RECEIVED'))
    const out = await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'enter_result', extra: { value: '6.5' }, db: m.db })
    const p = m.commits[0]!
    expect(p.expected_status).toBe('RECEIVED')
    expect(p.tenant_id).toBe(TENANT)
    expect((p.order as Record<string, unknown>).workflow_status).toBe('VERIFICATION_PENDING')
    expect(p.result).toMatchObject({ lab_order_id: ORDER, tenant_id: TENANT, patient_id: PATIENT, encounter_id: ENCOUNTER, abnormal_flag: 'N', entered_by: TECH, result_source: 'MANUAL' })
    expect(p.audit).toMatchObject({ action: 'LAB_RESULT_ENTERED' })
    // 6.5 is high on the demo/national 3.9–6.1 range but normal on this lab's 4–7.
    expect(out.result?.flag).toBe('N')
    expect(out.critical).toBe(false)
  })

  it('reports a critical value straight away', async () => {
    const m = setup(bundle('RECEIVED'))
    const out = await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'enter_result', extra: { value: '28' }, db: m.db })
    expect(out.critical).toBe(true)
    expect((m.commits[0]!.result as Record<string, unknown>).is_critical).toBe(true)
  })

  it('is fail-closed when the commit fails', async () => {
    const m = setup(bundle('RECEIVED'), { error: { message: 'boom' } })
    await expect(runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'enter_result', extra: { value: '6.5' }, db: m.db }))
      .rejects.toMatchObject({ code: 'LAB_COMMIT_FAILED', status: 500 })
  })

  it('turns a concurrent change into 409 LAB_STALE_ORDER', async () => {
    const m = setup(bundle('RECEIVED'), { error: { message: 'LAB_STALE_ORDER', code: 'LB409' } })
    const err = await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'enter_result', extra: { value: '6.5' }, db: m.db }).catch((e) => e)
    expect(err).toBeInstanceOf(LabActionError)
    expect(err).toMatchObject({ code: 'LAB_STALE_ORDER', status: 409 })
  })

  it('refuses an empty result', async () => {
    const m = setup(bundle('RECEIVED'))
    await expect(runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'enter_result', extra: { value: '  ' }, db: m.db })).rejects.toMatchObject({ status: 400 })
  })

  it('verify resolves the originating order result and records who verified', async () => {
    const m = setup(bundle('VERIFICATION_PENDING', { results: [resultRow()] }))
    const out = await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'verify', db: m.db })
    expect(out.result).toMatchObject({ id: RESULT, labOrderId: ORDER, patientId: PATIENT, tenantId: TENANT, status: 'final', verifiedBy: SCIENTIST })
    expect(out.order.status).toBe('VERIFIED')
    expect(m.commits[0]!.report).toBeNull()
  })

  it('refuses a result bound to another patient', async () => {
    const m = setup(bundle('VERIFICATION_PENDING', { results: [resultRow({ patient_id: '11111111-2222-4333-8444-555555555555' })] }))
    await expect(runLabAction({ ctx: ctx(), orderId: ORDER, action: 'verify', db: m.db })).rejects.toMatchObject({ code: 'LAB_RESULT_LINKAGE_MISMATCH' })
    expect(m.commits).toHaveLength(0)
  })

  it('ignores result rows of other orders or tenants in the bundle', async () => {
    const m = setup(bundle('VERIFICATION_PENDING', { results: [resultRow({ lab_order_id: 'ffb1e2c7-973b-45a3-b1b9-c8f44da82d72' }), resultRow({ tenant_id: OTHER_TENANT })] }))
    await expect(runLabAction({ ctx: ctx(), orderId: ORDER, action: 'verify', db: m.db })).rejects.toMatchObject({ status: 409 })
    expect(m.commits).toHaveLength(0)
  })

  it('warns when the person who entered the result also verifies it', async () => {
    const m = setup(bundle('VERIFICATION_PENDING', { results: [resultRow({ entered_by: SCIENTIST })] }))
    const out = await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'verify', db: m.db })
    expect(out.warnings).toContain('SELF_VERIFIED')
  })

  it('authorise verifies and releases in one commit with a named v2 report', async () => {
    const m = setup(bundle('VERIFICATION_PENDING', { results: [resultRow()] }))
    const out = await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'authorise', db: m.db })
    expect(m.commits).toHaveLength(1)
    expect(out.order.status).toBe('RELEASED')
    const report = m.commits[0]!.report as Record<string, unknown>
    expect(report).toMatchObject({ status: 'FINAL', version: 1, template_version: 'lab-report.v2', patient_id: PATIENT })
    const html = String(report.html_snapshot)
    expect(html).toContain('Kampala Diagnostics')
    expect(html).toContain('Nakato Jane')
    expect(html).toContain('Sarah Okello')
    expect(html).toContain('Tom Tech')
    expect(html).not.toContain(PATIENT)
    expect(out.reportId).toBe('rep-1')
    expect(m.commits[0]!.audit).toMatchObject({ action: 'LAB_RESULT_AUTHORISED' })
  })

  it('a walk-in release publishes the outbox event but creates no hospital tasks', async () => {
    const m = setup(bundle('VERIFIED', { results: [resultRow({ status: 'final', verified_by: SCIENTIST })] }))
    await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'release', db: m.db })
    expect(persist.events).toHaveBeenCalledTimes(1)
    expect(m.from).not.toHaveBeenCalledWith('department_tasks')
  })

  it('a hospital release completes the lab task and hands a review task to the doctor (STAT when critical)', async () => {
    const task = {
      id: '3c0a0000-0000-4000-8000-000000000001', tenant_id: TENANT, facility_id: HOSPITAL, hospital_id: HOSPITAL, patient_id: PATIENT,
      encounter_id: ENCOUNTER, requester_id: TECH, owner_department: 'lab', owner_role: 'lab_tech', task_type: 'lab_order',
      priority: 'ROUTINE', status: 'REQUESTED', title: 'Lab', source_resource: 'lab_orders', source_id: ORDER, correlation_id: ENCOUNTER,
      idempotency_key: 'k', created_at: '2026-11-21T08:00:00Z', updated_at: '2026-11-21T08:00:00Z',
    }
    const m = setup(bundle('VERIFIED', { order: { order_source: 'hospital' }, results: [resultRow({ status: 'final', verified_by: SCIENTIST, is_critical: true })] }), undefined, { department_tasks: { data: task } })
    await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'release', db: m.db })
    expect(m.from).toHaveBeenCalledWith('department_tasks')
    const persisted = persist.artifacts.mock.calls.at(-1)?.[1] as { tasks: Array<{ taskType: string; priority: string; status: string }> }
    expect(persisted.tasks.find((t) => t.taskType === 'lab_order')?.status).toBe('COMPLETED')
    expect(persisted.tasks.find((t) => t.taskType === 'doctor_result_review')?.priority).toBe('STAT')
  })

  it('a repeat release writes nothing and publishes nothing', async () => {
    const m = setup({ ...bundle('RELEASED', { results: [resultRow({ status: 'final', verified_by: SCIENTIST })] }), latestReport: { id: 'rep-0', version: 1, status: 'FINAL' } })
    const out = await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'release', db: m.db })
    expect(out).toMatchObject({ idempotent: true, reportId: 'rep-0' })
    expect(m.commits).toHaveLength(0)
    expect(persist.events).not.toHaveBeenCalled()
    expect(persist.timeline).not.toHaveBeenCalled()
  })

  it('collect allocates an accession and writes the specimen in the same commit', async () => {
    const m = setup(bundle('ORDERED'))
    const out = await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'collect', db: m.db })
    expect(m.rpc).toHaveBeenCalledWith('allocate_lab_accession', expect.objectContaining({ p_tenant_id: TENANT, p_facility_code: 'LAB' }))
    const p = m.commits[0]!
    expect(p.specimen).toMatchObject({ accession_number: 'LAB-20261121-000007', barcode: 'LAB-20261121-000007', container: 'Fluoride (grey)', patient_id: PATIENT })
    expect((p.order as Record<string, unknown>).workflow_status).toBe('COLLECTED')
    expect(out.order.accessionNumber).toBe('LAB-20261121-000007')
  })

  it('a collect retry after a committed collect writes nothing', async () => {
    const m = setup(bundle('COLLECTED'))
    const out = await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'collect', db: m.db })
    expect(out.idempotent).toBe(true)
    expect(m.rpc).not.toHaveBeenCalledWith('allocate_lab_accession', expect.anything())
    expect(m.commits).toHaveLength(0)
  })

  it('reject marks the specimen rejected using existing lab_specimens columns', async () => {
    const m = setup(bundle('RECEIVED'))
    const out = await runLabAction({ ctx: ctx(TECH, 'lab_tech'), orderId: ORDER, action: 'reject', extra: { reason: 'hemolyzed', note: 'pink serum' }, db: m.db })
    expect(m.commits[0]!.specimen_patch).toEqual({ status: 'rejected', condition: 'hemolyzed', id: SPECIMEN })
    expect(Object.keys(m.commits[0]!.specimen_patch as object)).not.toContain('rejection_reason')
    expect(out.order.status).toBe('REJECTED')
    expect(out.warnings).toEqual([])
  })

  it('amend needs a reason and writes the amendment and an AMENDED report version', async () => {
    const released = bundle('RELEASED', { results: [resultRow({ status: 'final', verified_by: SCIENTIST, released_to_patient_at: '2026-11-21T09:00:00Z' })] })
    const m = setup(released)
    await expect(runLabAction({ ctx: ctx(), orderId: ORDER, action: 'amend', extra: { value: '6.6' }, db: m.db })).rejects.toMatchObject({ status: 400 })
    await runLabAction({ ctx: ctx(), orderId: ORDER, action: 'amend', extra: { value: '6.6', reason: 'transcription' }, db: m.db })
    const p = m.commits[0]!
    expect(p.amendment).toMatchObject({ result_id: RESULT, previous_value: '6.5', new_value: '6.6', reason: 'transcription' })
    expect(p.report).toMatchObject({ status: 'AMENDED', version: 2, amendment_reason: 'transcription' })
    expect((p.result as Record<string, unknown>).status).toBe('corrected')
  })

  it('an analyser result for a different analyte cannot become this order’s result', async () => {
    const m = setup(bundle('RECEIVED'))
    await expect(runLabAction({ ctx: ctx(), orderId: ORDER, action: 'enter_result', extra: { value: '13.1', source: 'ANALYZER', expectLoinc: '718-7' }, db: m.db }))
      .rejects.toMatchObject({ code: 'LAB_ANALYTE_MISMATCH', status: 409 })
  })

  it('illegal transitions are 409, not 500', async () => {
    const m = setup(bundle('ORDERED'))
    await expect(runLabAction({ ctx: ctx(), orderId: ORDER, action: 'verify', db: m.db })).rejects.toMatchObject({ status: 409 })
    expect(callsOf(undefined, 'x')).toEqual([])
  })
})
