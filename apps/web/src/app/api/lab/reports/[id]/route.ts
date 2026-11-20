import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { PRINT_HTML_HEADERS } from '@/lib/lab/label'

export const dynamic = 'force-dynamic'

/**
 * A released report. ?format=html returns the immutable snapshot (A4 print
 * styles; the browser's print dialog saves it as PDF). There is no server-side
 * PDF renderer on the free tier, so `pdf` stays NOT_CONFIGURED.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('report.read')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Lab report not found' }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from('lab_reports')
    .select('id, tenant_id, facility_id, patient_id, encounter_id, lab_order_id, accession, status, version, report_type, generated_at, verified_by, released_at, supersedes_report_id, template_version, html_snapshot, content_hash')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('facility_id', ctx.hospitalId)
    .in('status', ['FINAL', 'AMENDED'])
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Lab report not found' }, { status: 404 })
  if (new URL(request.url).searchParams.get('format') === 'html') {
    return new NextResponse(data.html_snapshot, { headers: PRINT_HTML_HEADERS })
  }
  return NextResponse.json({
    report: {
      id: data.id,
      orderId: data.lab_order_id,
      status: data.status,
      version: data.version,
      accession: data.accession,
      releasedAt: data.released_at,
      supersedesReportId: data.supersedes_report_id,
      templateVersion: data.template_version,
      contentHash: data.content_hash,
      printUrl: `/api/lab/reports/${data.id}?format=html`,
      pdf: 'NOT_CONFIGURED',
    },
  })
}
