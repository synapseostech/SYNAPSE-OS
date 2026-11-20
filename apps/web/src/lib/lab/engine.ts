import 'server-only'

import { supabaseAdmin } from '@synapse/db/admin'
import {
  LabWorkflow,
  SPECIMEN_REJECTION_REASONS,
  type LabOrder,
  type LabResult,
  type SpecimenRejectionReason,
} from '@synapse/db/lab-workflow'
import { labOrderToRow, rowToLabOrder } from '@synapse/db/lab-order-persist'
import { allocateAccessionNumber, labResultToRow, rowToLabResult } from '@synapse/db/lab-result-persist'
import { buildLabReportArtifact } from '@synapse/db/lab-report'
import { ageInYears, formatAge, normaliseLabSex, rowsToReferenceRanges, type LabReferenceRangeRow } from '@synapse/db/lab-ranges'
import { ExchangeOutbox } from '@synapse/db/exchange'
import { WorkQueue } from '@synapse/db/work-queue'
import { persistDomainEventsBestEffort, persistWorkQueueArtifactsBestEffort, rowToDepartmentTask } from '@synapse/db/work-queue-persist'
import { labResultReleasedTimelineEvent, publishClinicalTimelineBestEffort } from '@synapse/db/clinical-timeline'
import { publishTimelineEvent } from '@synapse/db/identity-persist'
import type { HospitalContext } from '../hospital-shared/context'
import { isRepeatLabRelease } from '../lab-release-idempotency'

/**
 * Synapse Lab action engine.
 *
 * Per action: ONE read (`lab_order_bundle`) and ONE write
 * (`lab_commit_action`), plus an accession number on first collection. The
 * write carries the order, specimen, result, amendment, critical
 * acknowledgement, report and audit row and commits them together, guarded by
 * the status the order had when it was read, so two people acting on the same
 * order cannot both win and an audit failure can no longer leave a committed
 * change behind a 503.
 *
 * `LabWorkflow` (packages/db) remains the only state machine. Hospital
 * hand-offs (doctor review task, outbox event, timeline) run after the commit,
 * as before, and only report warnings if they fail.
 */

export const LAB_ACTIONS = [
  'collect', 'receive', 'reject', 'enter_result', 'verify', 'release', 'authorise', 'amend', 'acknowledge',
] as const
export type LabActionName = (typeof LAB_ACTIONS)[number]

export function isLabAction(value: string): value is LabActionName {
  return (LAB_ACTIONS as readonly string[]).includes(value)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class LabActionError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string) {
    super(message ?? code)
    this.name = 'LabActionError'
  }
}

export type LabEngineContext = HospitalContext & { facilityName?: string | null }

type Row = Record<string, unknown>

export type LabOrderBundle = {
  order: Row
  results: Row[]
  specimen: Row | null
  patient: { id: string; fullName: string | null; mrn: string | null; sex: string | null; dob: string | null; phone: string | null; personId: string | null } | null
  encounterHospitalId: string | null
  ranges: LabReferenceRangeRow[]
  catalog: Row | null
  people: Record<string, string | null>
  latestReport: { id: string; version: number; status: string } | null
}

export type LabActionOutcome = {
  order: LabOrder
  result: LabResult | null
  warnings: string[]
  /** true when nothing was written because the action had already happened. */
  idempotent: boolean
  reportId: string | null
  critical: boolean
  specimenId: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export async function loadLabOrderBundle(db: Db, ctx: LabEngineContext, orderId: string): Promise<LabOrderBundle | null> {
  if (!UUID.test(orderId)) return null
  const { data, error } = await db.rpc('lab_order_bundle', {
    p_tenant_id: ctx.tenantId,
    p_order_id: orderId,
    p_hospital_id: ctx.hospitalId,
  })
  if (error) throw new LabActionError('LAB_LOAD_FAILED', 500, error.message)
  if (!data || typeof data !== 'object' || !(data as Row).order) return null
  const bundle = data as LabOrderBundle
  // Defence in depth: the function filters by tenant, so must every row.
  if (String(bundle.order.tenant_id) !== ctx.tenantId) return null
  bundle.results = (bundle.results ?? []).filter((row) => String(row.tenant_id) === ctx.tenantId && String(row.lab_order_id) === orderId)
  bundle.people = bundle.people ?? {}
  bundle.ranges = bundle.ranges ?? []
  return bundle
}

function text(value: unknown, max = 500): string {
  return String(value ?? '').trim().slice(0, max)
}

type CommitPayload = {
  order: Row
  specimen?: Row | null
  specimen_patch?: Row | null
  result?: Row | null
  amendment?: Row | null
  ack?: Row | null
  report?: Row | null
  audit: { action: string; table_name?: string; record_id?: string; new_value?: Row }
}

async function commit(db: Db, ctx: LabEngineContext, orderId: string, expectedStatus: string, payload: CommitPayload): Promise<{ reportId: string | null }> {
  const { data, error } = await db.rpc('lab_commit_action', {
    p: {
      tenant_id: ctx.tenantId,
      order_id: orderId,
      actor_id: ctx.userId,
      actor_role: ctx.role,
      expected_status: expectedStatus,
      ...payload,
    },
  })
  if (error) {
    const message = String(error.message ?? '')
    if (error.code === 'LB409' || /LAB_STALE_ORDER/.test(message)) {
      throw new LabActionError('LAB_STALE_ORDER', 409, 'This order was changed by someone else. Reload it and try again.')
    }
    throw new LabActionError('LAB_COMMIT_FAILED', 500, message || 'lab_commit_action failed')
  }
  return { reportId: (data as { reportId?: string | null } | null)?.reportId ?? null }
}

function reportFor(params: {
  ctx: LabEngineContext
  bundle: LabOrderBundle
  order: LabOrder
  result: LabResult
  status: 'FINAL' | 'AMENDED'
  verifierName: string | null
  amendmentReason?: string | null
}) {
  const { ctx, bundle, order, result } = params
  const patient = bundle.patient
  const enteredBy = bundle.results.find((row) => String(row.id) === result.id)?.entered_by
  return buildLabReportArtifact({
    id: crypto.randomUUID(),
    tenantId: ctx.tenantId,
    facilityId: ctx.hospitalId,
    patientId: order.patientId,
    encounterId: order.encounterId,
    orderId: order.id,
    clinicalResultId: result.id,
    accession: order.accessionNumber ?? order.id,
    testName: order.testName,
    loincCode: order.loincCode,
    specimenType: (bundle.specimen?.specimen_type as string | null) ?? (bundle.catalog?.specimen_type as string | null) ?? null,
    collectedAt: (bundle.specimen?.collected_at as string | null) ?? null,
    receivedAt: (bundle.specimen?.received_at as string | null) ?? null,
    reportedAt: result.releasedAt ?? new Date().toISOString(),
    resultValue: result.resultValue,
    unit: result.unit,
    referenceRange: result.referenceRange,
    abnormalFlag: result.flag,
    isCritical: result.isCritical,
    verifiedBy: result.verifiedBy ?? ctx.userId,
    version: result.version,
    status: params.status,
    amendmentReason: params.amendmentReason ?? null,
    facilityName: ctx.facilityName ?? 'Laboratory',
    patientName: patient?.fullName ?? null,
    patientMrn: patient?.mrn ?? null,
    patientSex: patient?.sex ?? null,
    patientAge: formatAge(patient?.dob ?? null),
    section: (bundle.order.section as string | null) ?? null,
    enteredByName: enteredBy ? bundle.people[String(enteredBy)] ?? null : null,
    verifiedByName: params.verifierName,
    referralSource: (bundle.order.referral_source as string | null) ?? null,
  })
}

function reportRow(report: ReturnType<typeof buildLabReportArtifact>): Row {
  return {
    id: report.id,
    facility_id: report.facilityId,
    patient_id: report.patientId,
    encounter_id: report.encounterId,
    clinical_result_id: report.clinicalResultId,
    accession: report.accession,
    status: report.status,
    version: report.version,
    released_at: report.reportedAt,
    verified_by: report.verifiedBy,
    amendment_reason: report.amendmentReason ?? null,
    template_version: report.templateVersion,
    html_snapshot: report.htmlSnapshot,
    content_hash: report.contentHash,
  }
}

function resultRow(result: LabResult, order: LabOrder, extras: { enteredBy?: string | null; source?: string } = {}): Row {
  return labResultToRow(result, { encounterId: order.encounterId, enteredBy: extras.enteredBy ?? null, source: extras.source })
}

export async function runLabAction(params: {
  ctx: LabEngineContext
  orderId: string
  action: string
  extra?: Record<string, unknown>
  db?: Db
}): Promise<LabActionOutcome> {
  const db: Db = params.db ?? supabaseAdmin
  const { ctx, orderId } = params
  const extra = params.extra ?? {}
  if (!isLabAction(params.action)) throw new LabActionError('LAB_UNKNOWN_ACTION', 400, 'Unknown action')
  const action = params.action

  const bundle = await loadLabOrderBundle(db, ctx, orderId)
  if (!bundle) throw new LabActionError('LAB_ORDER_NOT_FOUND', 404, 'Lab order not found')

  const order = rowToLabOrder(bundle.order)
  const priorResults = bundle.results.map(rowToLabResult)
  for (const prior of priorResults) {
    if (prior.labOrderId !== order.id || prior.tenantId !== ctx.tenantId || prior.patientId !== order.patientId) {
      throw new LabActionError('LAB_RESULT_LINKAGE_MISMATCH', 409, 'Result does not belong to this order')
    }
  }
  const expected = order.status
  const lab = new LabWorkflow([order], priorResults)
  const warnings: string[] = []
  const sex = normaliseLabSex(bundle.patient?.sex)
  const ageYears = ageInYears(bundle.patient?.dob ?? null)
  const ranges = rowsToReferenceRanges(bundle.ranges, ctx.tenantId)
  const priorResult = priorResults[0] ?? null
  const idle = (result: LabResult | null = priorResult): LabActionOutcome => ({
    order, result, warnings, idempotent: true, reportId: bundle.latestReport?.id ?? null,
    critical: Boolean(result?.isCritical), specimenId: order.specimenId ?? null,
  })

  const fail = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err)
    const code = message.split(':')[0] || 'LAB_ACTION_FAILED'
    throw new LabActionError(code, 409, message)
  }

  let payload: CommitPayload
  let result: LabResult | null = null
  let specimenId: string | null = order.specimenId ?? null

  switch (action) {
    case 'collect': {
      if (!['ORDERED', 'COLLECTION_PENDING'].includes(order.status)) {
        if (['REJECTED', 'CANCELLED'].includes(order.status)) {
          throw new LabActionError('LAB_ORDER_CLOSED', 409, `Order is ${order.status}; place a replacement order to recollect`)
        }
        if (!order.specimenId || !order.accessionNumber) {
          throw new LabActionError('LAB_COLLECT_RETRY_INCOMPLETE', 409, 'specimen reconciliation required')
        }
        return idle()
      }
      const accession = text(extra.accessionNumber, 40) ||
        await allocateAccessionNumber(db, ctx.tenantId, ctx.facilityType === 'laboratory' ? 'LAB' : 'HOSP')
      if (!/^[A-Za-z0-9-]{4,40}$/.test(accession)) throw new LabActionError('LAB_ACCESSION_INVALID', 400, 'Accession must be 4–40 letters, digits or dashes')
      specimenId = crypto.randomUUID()
      try { lab.collect(order.id, accession, accession, specimenId) } catch (err) { fail(err) }
      payload = {
        order: labOrderToRow(lab.getOrder(order.id)),
        specimen: {
          id: specimenId,
          patient_id: order.patientId,
          person_id: order.personId ?? null,
          encounter_id: order.encounterId,
          accession_number: accession,
          barcode: accession,
          specimen_type: text(extra.specimenType, 60) || (bundle.catalog?.specimen_type as string | undefined) || 'blood',
          container: text(extra.container, 60) || (bundle.catalog?.container as string | undefined) || null,
        },
        audit: { action: 'LAB_SPECIMEN_COLLECTED', new_value: { accession, specimenId } },
      }
      break
    }
    case 'receive': {
      if (order.status === 'RECEIVED') return idle()
      try { lab.receive(order.id) } catch (err) { fail(err) }
      payload = {
        order: labOrderToRow(lab.getOrder(order.id)),
        specimen_patch: { status: 'in_lab', id: order.specimenId ?? null },
        audit: { action: 'LAB_SPECIMEN_RECEIVED', new_value: { specimenId: order.specimenId ?? null } },
      }
      break
    }
    case 'reject': {
      if (order.status === 'REJECTED') return idle()
      const raw = text(extra.reason ?? extra.rejectionReason, 60) || 'other'
      const reason = ((SPECIMEN_REJECTION_REASONS as readonly string[]).includes(raw) ? raw : 'other') as SpecimenRejectionReason
      const note = text(extra.note ?? extra.rejectionNote) || raw
      try { lab.reject(order.id, reason, note) } catch (err) { fail(err) }
      payload = {
        order: labOrderToRow(lab.getOrder(order.id)),
        specimen_patch: { status: 'rejected', condition: reason, id: order.specimenId ?? null },
        audit: { action: 'LAB_SPECIMEN_REJECTED', new_value: { reason, note } },
      }
      break
    }
    case 'enter_result': {
      const value = text(extra.value, 200)
      if (!value) throw new LabActionError('LAB_RESULT_VALUE_REQUIRED', 400, 'Enter a result value')
      const source = text(extra.source, 20).toUpperCase() === 'ANALYZER' ? 'ANALYZER' : 'MANUAL'
      // Analyser results arrive per analyte under one accession: only the
      // analyte this order asked for may become its result.
      if (typeof extra.expectLoinc === 'string' && extra.expectLoinc !== order.loincCode) {
        throw new LabActionError('LAB_ANALYTE_MISMATCH', 409, `Analyser result ${extra.expectLoinc} does not match the ordered test ${order.loincCode}`)
      }
      try {
        result = lab.enterResult({
          resultId: priorResult?.id ?? crypto.randomUUID(),
          orderId: order.id,
          value,
          analyzer: text(extra.analyzer, 120) || (source === 'ANALYZER' ? 'analyzer' : 'manual'),
          sex,
          ageYears,
          ranges,
          unit: (bundle.catalog?.unit as string | null) ?? null,
        }).result
      } catch (err) { fail(err) }
      const comment = text(extra.comment, 1000)
      payload = {
        order: labOrderToRow(lab.getOrder(order.id)),
        result: { ...resultRow(result!, order, { enteredBy: ctx.userId, source }), ...(comment ? { notes: comment } : {}) },
        audit: { action: 'LAB_RESULT_ENTERED', table_name: 'lab_results', record_id: result!.id, new_value: { orderId: order.id, flag: result!.flag, critical: result!.isCritical, source } },
      }
      break
    }
    case 'verify':
    case 'release':
    case 'authorise': {
      if (action === 'verify' && ['VERIFIED', 'RELEASED', 'AMENDED'].includes(order.status)) return idle()
      // A repeat release writes nothing and publishes nothing (no second timeline event).
      if (action !== 'verify' && isRepeatLabRelease(order.status)) return idle()
      try {
        if (action !== 'release') result = lab.verify(order.id, ctx.userId)
        if (action !== 'verify') result = lab.release(order.id)
      } catch (err) { fail(err) }
      const updated = lab.getOrder(order.id)
      let report: Row | null = null
      if (action !== 'verify') {
        const verifierName = result!.verifiedBy === ctx.userId ? ctx.fullName : bundle.people[String(result!.verifiedBy)] ?? null
        report = reportRow(reportFor({ ctx, bundle, order: updated, result: result!, status: 'FINAL', verifierName }))
      }
      const enteredBy = bundle.results.find((row) => String(row.id) === result!.id)?.entered_by
      if (action !== 'release' && enteredBy && String(enteredBy) === ctx.userId) warnings.push('SELF_VERIFIED')
      payload = {
        order: labOrderToRow(updated),
        result: resultRow(result!, order),
        report,
        audit: {
          action: action === 'verify' ? 'LAB_RESULT_VERIFIED' : action === 'release' ? 'LAB_REPORT_RELEASED' : 'LAB_RESULT_AUTHORISED',
          new_value: { orderStatus: updated.status, resultId: result!.id, critical: result!.isCritical, selfVerified: warnings.includes('SELF_VERIFIED') },
        },
      }
      break
    }
    case 'amend': {
      const value = text(extra.value ?? extra.newValue, 200)
      const reason = text(extra.reason, 500)
      if (!value || !reason) throw new LabActionError('LAB_AMEND_REASON_REQUIRED', 400, 'An amendment needs the new value and a reason')
      const amendmentId = typeof extra.amendmentId === 'string' && UUID.test(extra.amendmentId) ? extra.amendmentId : crypto.randomUUID()
      let amendment
      try {
        const out = lab.amend({ amendmentId, orderId: order.id, newValue: value, reason, amendedBy: ctx.userId, sex, ageYears, ranges })
        result = out.result
        amendment = out.amendment
      } catch (err) { fail(err) }
      result!.releasedAt = new Date().toISOString()
      const updated = lab.getOrder(order.id)
      const report = reportRow(reportFor({ ctx, bundle, order: updated, result: result!, status: 'AMENDED', verifierName: ctx.fullName, amendmentReason: reason }))
      report.verified_by = ctx.userId
      payload = {
        order: labOrderToRow(updated),
        result: { ...resultRow(result!, order), verified_by: ctx.userId },
        amendment: {
          id: amendment!.id,
          result_id: amendment!.resultId,
          previous_value: amendment!.previousValue,
          previous_status: amendment!.previousStatus,
          new_value: amendment!.newValue,
          reason,
        },
        report,
        audit: { action: 'LAB_RESULT_AMENDED', table_name: 'lab_results', record_id: result!.id, new_value: { previous: amendment!.previousValue, value, reason, version: result!.version } },
      }
      break
    }
    case 'acknowledge': {
      let ack
      try {
        ack = lab.acknowledgeCritical({ id: crypto.randomUUID(), orderId: order.id, acknowledgedBy: ctx.userId, note: text(extra.note) || 'acknowledged' })
      } catch (err) { fail(err) }
      result = priorResult
      payload = {
        order: labOrderToRow(order),
        ack: { id: ack!.id, result_id: ack!.resultId, patient_id: order.patientId, note: ack!.note },
        audit: { action: 'LAB_CRITICAL_ACKNOWLEDGED', table_name: 'lab_results', record_id: ack!.resultId, new_value: { note: ack!.note } },
      }
      break
    }
  }

  const { reportId } = await commit(db, ctx, order.id, expected, payload!)
  const updated = lab.getOrder(order.id)
  const outcome: LabActionOutcome = {
    order: updated,
    result: result ?? priorResult,
    warnings,
    idempotent: false,
    reportId: reportId ?? bundle.latestReport?.id ?? null,
    critical: Boolean((result ?? priorResult)?.isCritical),
    specimenId,
  }

  // ---- hand-offs after the commit (best effort, reported as warnings) ----
  const fromHospital = String(bundle.order.order_source ?? 'hospital') === 'hospital'
  if (action === 'reject' && fromHospital) {
    await closeOpenLabTasks(db, ctx, order.id, `Specimen rejected; replacement order required`, warnings)
  }
  if ((action === 'release' || action === 'authorise' || action === 'amend') && outcome.result) {
    await publishRelease(db, ctx, updated, outcome.result, outcome.reportId, fromHospital, action, warnings)
  }
  return outcome
}

async function closeOpenLabTasks(db: Db, ctx: LabEngineContext, orderId: string, reason: string, warnings: string[]) {
  try {
    const { data: rows } = await db
      .from('department_tasks')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('source_resource', 'lab_orders')
      .eq('source_id', orderId)
      .eq('task_type', 'lab_order')
      .in('status', ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD'])
    const queue = new WorkQueue()
    const closed = []
    for (const row of rows ?? []) {
      const task = rowToDepartmentTask(row)
      queue.tasks.set(task.id, task)
      const cancelled = queue.cancel(task.id, reason)
      if (cancelled.ok) closed.push(cancelled.task)
    }
    if (closed.length) {
      const persisted = await persistWorkQueueArtifactsBestEffort(db, { tasks: closed, events: [] })
      if (persisted.errors.length) warnings.push(...persisted.errors)
    }
  } catch (err) {
    warnings.push(`LAB_TASK_CLOSE_FAILED:${err instanceof Error ? err.message : 'unknown'}`)
  }
}

async function publishRelease(
  db: Db,
  ctx: LabEngineContext,
  order: LabOrder,
  result: LabResult,
  reportId: string | null,
  fromHospital: boolean,
  action: string,
  warnings: string[],
) {
  try {
    if (reportId) {
      const outbox = new ExchangeOutbox()
      const event = outbox.append({
        eventType: 'LabResultReleased',
        tenantId: ctx.tenantId,
        facilityId: ctx.hospitalId,
        actorId: ctx.userId,
        patientId: order.patientId,
        encounterId: order.encounterId,
        correlationId: order.correlationId,
        payload: { reportId, resultId: result.id, accession: order.accessionNumber ?? null, amended: action === 'amend' },
        source: 'synapse-lab',
        aggregateId: order.id,
        action: action === 'amend' ? 'amended' : 'released',
      })
      const persisted = await persistDomainEventsBestEffort(db, [event])
      if (!persisted.ok) warnings.push(persisted.error)
    }

    // Hospital contract: the lab task completes and the ordering doctor gets a
    // review task (STAT when critical). Walk-in and referral orders have none.
    if (fromHospital && action !== 'amend') {
      const { data: labTaskRow } = await db
        .from('department_tasks')
        .select('*')
        .eq('tenant_id', ctx.tenantId)
        .eq('source_resource', 'lab_orders')
        .eq('source_id', order.id)
        .eq('task_type', 'lab_order')
        .maybeSingle()
      if (labTaskRow) {
        const queue = new WorkQueue()
        const labTask = rowToDepartmentTask(labTaskRow)
        queue.tasks.set(labTask.id, labTask)
        if (labTask.status === 'REQUESTED') queue.start(labTask.id, ctx.userId)
        if (queue.get(labTask.id)?.status === 'IN_PROGRESS') queue.complete(labTask.id, 'Laboratory result released', ctx.userId)
        const review = queue.create({
          tenantId: ctx.tenantId,
          facilityId: ctx.hospitalId,
          hospitalId: ctx.hospitalId,
          patientId: order.patientId,
          encounterId: order.encounterId,
          requesterId: ctx.userId,
          ownerDepartment: 'opd',
          ownerRole: 'doctor',
          taskType: 'doctor_result_review',
          priority: result.isCritical ? 'STAT' : 'ROUTINE',
          title: result.isCritical ? 'CRITICAL RESULT: Doctor review' : 'Doctor review: released result',
          description: `Review released ${order.testName} for the ordering encounter`,
          sourceResource: 'lab_results',
          sourceId: result.id,
          correlationId: order.correlationId,
          idempotencyKey: `lab_results:${result.id}:doctor-result-review`,
        })
        if (review.ok) {
          const persisted = await persistWorkQueueArtifactsBestEffort(db, {
            tasks: [labTask, review.task],
            events: queue.outbox.list({ correlationId: order.correlationId }),
          })
          if (persisted.errors.length) warnings.push(...persisted.errors)
        } else {
          warnings.push(review.error)
        }
      }
    }

    void publishClinicalTimelineBestEffort(
      publishTimelineEvent,
      labResultReleasedTimelineEvent({
        tenantId: ctx.tenantId,
        hospitalId: ctx.hospitalId,
        patientId: order.patientId,
        orderId: order.id,
        encounterId: order.encounterId,
        testName: order.testName,
        resultValue: result.resultValue,
        releasedBy: ctx.userId,
      }),
    )
  } catch (err) {
    warnings.push(`LAB_RELEASE_HANDOFF_FAILED:${err instanceof Error ? err.message : 'unknown'}`)
  }
}
