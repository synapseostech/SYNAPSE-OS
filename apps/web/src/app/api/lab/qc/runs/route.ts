import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { qcRecordError, qcRunSchema } from '@/lib/lab/qc'

export const dynamic = 'force-dynamic'

/**
 * Record one QC run (one to three levels of one analyte). The Westgard rules
 * are evaluated and the runs, control status and audit row are written in one
 * transaction by lab_qc_record.
 */
export async function POST(request: Request) {
  const ctx = await requireLabAccess('qc.record')
  if (isLabContextError(ctx)) return ctx
  const parsed = qcRunSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc('lab_qc_record', {
    p: {
      tenant_id: ctx.tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.role,
      comment: parsed.data.comment ?? null,
      run_at: parsed.data.runAt ?? null,
      results: parsed.data.results.map((r) => ({ material_id: r.materialId, value: r.value })),
    },
  })
  if (error) {
    const mapped = qcRecordError(error)
    return NextResponse.json({ error: mapped.message }, { status: mapped.status })
  }
  return NextResponse.json({ batch: data }, { status: 201 })
}
