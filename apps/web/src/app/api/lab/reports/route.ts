import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'

export const dynamic = 'force-dynamic'

/** Released reports, newest first, paged by released_at. Uses idx_lab_reports_patient for a patient. */
export async function GET(request: Request) {
  const ctx = await requireLabAccess('report.read')
  if (isLabContextError(ctx)) return ctx
  const params = new URL(request.url).searchParams
  const limit = Math.min(Math.max(Number(params.get('limit')) || 30, 1), 100)
  const before = params.get('before')
  const patientId = params.get('patientId')
  const accession = (params.get('accession') ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabaseAdmin as any)
    .from('lab_reports')
    .select('id, lab_order_id, patient_id, accession, status, version, released_at, template_version, lab_report_deliveries(channel, status, created_at)')
    .eq('tenant_id', ctx.tenantId)
    .eq('facility_id', ctx.hospitalId)
    .in('status', ['FINAL', 'AMENDED'])
  if (patientId && /^[0-9a-f-]{36}$/i.test(patientId)) query = query.eq('patient_id', patientId)
  if (accession) query = query.ilike('accession', `${accession}%`)
  if (before && !Number.isNaN(Date.parse(before))) query = query.lt('released_at', new Date(before).toISOString())
  const { data, error } = await query.order('released_at', { ascending: false }).limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const reports = (data ?? []) as Array<Record<string, unknown>>
  const next = reports.length === limit ? String(reports[reports.length - 1]?.released_at ?? '') || null : null
  return NextResponse.json({ reports, nextBefore: next })
}
