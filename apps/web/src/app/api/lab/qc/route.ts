import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { QC_MANAGE_ROLES, qcStatistics, summariseQc, type QcMaterialRow, type QcRunRow } from '@/lib/lab/qc'

export const dynamic = 'force-dynamic'

const QC_MATERIAL_COLUMNS = 'id, loinc_code, analyte_name, unit, material_name, lot_number, level, target_mean, target_sd, expires_on, device_id, is_active, last_run_at, last_run_status, updated_at'
const RUN_COLUMNS = 'id, material_id, batch_id, value, target_mean, target_sd, z_score, rules, status, comment, corrective_action, corrected_at, run_at, entered_by'
const MAX_DAYS = 180

/**
 * The QC board: every control with its recent runs (for the Levey-Jennings
 * chart), observed statistics and one summary row per analyte (locked, not
 * run today, lot expiring). Two queries, bounded by days and row count.
 */
export async function GET(request: Request) {
  const ctx = await requireLabAccess('qc.record')
  if (isLabContextError(ctx)) return ctx
  const params = new URL(request.url).searchParams
  const days = Math.min(MAX_DAYS, Math.max(1, Number(params.get('days')) || 60))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  let materialQuery = db.from('lab_qc_materials').select(QC_MATERIAL_COLUMNS).eq('tenant_id', ctx.tenantId)
  if (params.get('all') !== '1') materialQuery = materialQuery.eq('is_active', true)
  const { data: materials, error } = await materialQuery.order('analyte_name').order('level').limit(300)
  if (error) return NextResponse.json({ error: 'Could not load quality control' }, { status: 500 })
  const list = (materials ?? []) as QcMaterialRow[]

  let runs: QcRunRow[] = []
  if (list.length) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const { data, error: runError } = await db
      .from('lab_qc_runs')
      .select(RUN_COLUMNS)
      .eq('tenant_id', ctx.tenantId)
      .in('material_id', list.map((m) => m.id))
      .gte('run_at', since)
      .order('run_at', { ascending: false })
      .limit(3000)
    if (runError) return NextResponse.json({ error: 'Could not load quality control runs' }, { status: 500 })
    runs = (data ?? []) as QcRunRow[]
  }

  const runsByMaterial: Record<string, QcRunRow[]> = {}
  for (const run of runs) (runsByMaterial[run.material_id] ??= []).push(run)

  return NextResponse.json({
    days,
    summary: summariseQc(list),
    materials: list.map((m) => ({ ...m, runs: runsByMaterial[m.id] ?? [], observed: qcStatistics(runsByMaterial[m.id] ?? []) })),
    // A hint for the screen only; the materials routes check lab.qc.manage themselves.
    canManage: QC_MANAGE_ROLES.has(ctx.role),
  })
}
