import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@synapse/db/admin'
import { nextWorklistStatus, validateReportDraft, type RadiologyAction } from '@synapse/db/radiology'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  action: z.enum(['start', 'report', 'verify', 'cancel']),
  technique: z.string().max(8000).optional(),
  findings: z.string().max(8000).optional(),
  impression: z.string().max(8000).optional(),
  recommendation: z.string().max(8000).optional(),
  is_critical: z.boolean().optional(),
  reason: z.string().max(500).optional(),
}).strict()

/** Which capability each step needs. */
const CAPABILITY: Record<RadiologyAction, [string, string]> = {
  start: ['report', 'write'],
  report: ['report', 'write'],
  verify: ['report', 'verify'],
  cancel: ['order', 'create'],
}

/**
 * Radiology workflow step on one study. The status change is guarded by the
 * status the caller saw (optimistic: a concurrent change answers 409).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const action = parsed.data.action
  const [resource, verb] = CAPABILITY[action]
  const cap = await requireHospitalCapability(ctx, resource, verb, 'radiology')
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'radiology')
  if (moduleBlock) return moduleBlock

  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Study not found' }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: study, error } = await db
    .from('imaging_studies')
    .select('id, encounter_id, patient_id, modality, body_part, worklist_status, metadata')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .eq('is_deleted', false)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not load the study' }, { status: 500 })
  if (!study) return NextResponse.json({ error: 'Study not found' }, { status: 404 })

  const step = nextWorklistStatus(action, String(study.worklist_status))
  if (!step.ok) return NextResponse.json({ error: step.reason, code: 'RADIOLOGY_STEP_NOT_ALLOWED' }, { status: 409 })
  const now = new Date().toISOString()

  // Report text first (report and verify), then the guarded status change.
  let reportId: string | null = null
  if (action === 'report' || action === 'verify') {
    const { data: prior } = await db
      .from('radiology_reports')
      .select('id, technique, findings, impression, recommendation, is_critical, radiographer_id')
      .eq('tenant_id', ctx.tenantId)
      .eq('study_id', study.id)
      .eq('is_deleted', false)
      .maybeSingle()
    if (action === 'verify' && !prior) return NextResponse.json({ error: 'There is no report to verify' }, { status: 409 })
    const merged = {
      technique: parsed.data.technique ?? prior?.technique,
      findings: parsed.data.findings ?? prior?.findings,
      impression: parsed.data.impression ?? prior?.impression,
      recommendation: parsed.data.recommendation ?? prior?.recommendation,
      isCritical: parsed.data.is_critical ?? prior?.is_critical,
    }
    const valid = validateReportDraft(merged)
    if (!valid.ok) return NextResponse.json({ error: valid.reason }, { status: 400 })
    const row = {
      technique: valid.draft.technique,
      findings: valid.draft.findings,
      impression: valid.draft.impression,
      recommendation: valid.draft.recommendation,
      is_critical: valid.draft.isCritical,
      updated_at: now,
      ...(action === 'verify'
        ? { status: 'final', radiologist_id: ctx.userId, reported_at: now }
        : { status: 'preliminary', radiographer_id: prior?.radiographer_id ?? ctx.userId }),
    }
    if (prior) {
      const { error: upError } = await db.from('radiology_reports').update(row).eq('id', prior.id).eq('tenant_id', ctx.tenantId)
      if (upError) return NextResponse.json({ error: 'Could not save the report' }, { status: 500 })
      reportId = prior.id
    } else {
      const { data: created, error: insError } = await db
        .from('radiology_reports')
        .insert({
          ...row,
          tenant_id: ctx.tenantId,
          hospital_id: ctx.hospitalId,
          encounter_id: study.encounter_id,
          study_id: study.id,
          modality: study.modality,
          body_part: study.body_part,
        })
        .select('id')
        .single()
      if (insError) return NextResponse.json({ error: 'Could not save the report' }, { status: 500 })
      reportId = created.id
    }
  }

  const patch: Record<string, unknown> =
    step.to === 'cancelled'
      ? { is_deleted: true, updated_at: now, metadata: { ...(study.metadata ?? {}), cancelled_by: ctx.userId, cancelled_at: now, cancel_reason: parsed.data.reason ?? null } }
      : { worklist_status: step.to, updated_at: now, ...(action === 'start' ? { metadata: { ...(study.metadata ?? {}), started_by: ctx.userId, started_at: now } } : {}) }
  const { data: moved, error: moveError } = await db
    .from('imaging_studies')
    .update(patch)
    .eq('id', study.id)
    .eq('tenant_id', ctx.tenantId)
    .eq('worklist_status', study.worklist_status)
    .eq('is_deleted', false)
    .select('id, worklist_status')
  if (moveError) return NextResponse.json({ error: 'Could not update the study' }, { status: 500 })
  if (!moved || moved.length === 0) {
    return NextResponse.json({ error: 'The study changed since it was loaded; reload and try again', code: 'RADIOLOGY_STALE' }, { status: 409 })
  }

  await logHospitalAudit({
    ctx,
    action: `RADIOLOGY_${action.toUpperCase()}`,
    tableName: 'imaging_studies',
    recordId: study.id,
    newValue: { from: study.worklist_status, to: step.to, report_id: reportId, critical: parsed.data.is_critical ?? null, patient_id: study.patient_id },
  })
  return NextResponse.json({ studyId: study.id, worklistStatus: step.to, reportId })
}
