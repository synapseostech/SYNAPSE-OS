import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError, requireHospitalCapability, gateHospitalModule } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

const VIEWS: Record<string, string[]> = {
  pending: ['pending'],
  in_progress: ['in_progress'],
  reported: ['reported'],
  verified: ['verified'],
  open: ['pending', 'in_progress', 'reported'],
}

/** Imaging worklist for radiographers and radiologists, STAT first. ?view=open|pending|in_progress|reported|verified */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const cap = await requireHospitalCapability(ctx, 'order', 'read', 'radiology')
  if (cap) return cap
  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'radiology')
  if (moduleBlock) return moduleBlock

  const view = req.nextUrl.searchParams.get('view') ?? 'open'
  const statuses = VIEWS[view]
  if (!statuses) return NextResponse.json({ error: 'Unknown view' }, { status: 400 })
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 60)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db
    .from('imaging_studies')
    .select('id, encounter_id, patient_id, accession_number, modality, body_part, laterality, study_description, clinical_indication, priority, is_urgent, worklist_status, metadata, created_at, updated_at, patients(full_name, mrn, sex, dob), radiology_reports(id, status, findings, impression, technique, recommendation, is_critical, radiographer_id, radiologist_id, reported_at)')
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .eq('is_deleted', false)
    .in('worklist_status', statuses)
    .order('created_at', { ascending: view === 'verified' ? false : true })
    .limit(200)
  if (q) query = query.ilike('accession_number', `%${q.replace(/[\\%_]/g, (c: string) => `\\${c}`)}%`)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: 'Could not load the worklist' }, { status: 500 })
  const rank = (p: string) => (p === 'stat' ? 0 : p === 'urgent' ? 1 : 2)
  const studies = [...(data ?? [])].sort((a: { priority: string; created_at: string }, b: { priority: string; created_at: string }) =>
    view === 'verified' ? 0 : rank(a.priority) - rank(b.priority) || a.created_at.localeCompare(b.created_at))
  return NextResponse.json({ studies, role: ctx.role }, { headers: { 'Cache-Control': 'private, no-store' } })
}
