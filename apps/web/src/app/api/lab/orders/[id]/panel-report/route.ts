import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { renderPanelReportHtml } from '@synapse/db/lab-report'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { PRINT_HTML_HEADERS } from '@/lib/lab/label'

export const dynamic = 'force-dynamic'

const RELEASED = new Set(['RELEASED', 'AMENDED'])

function age(dob: string | null | undefined): string | null {
  if (!dob) return null
  const years = (Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000)
  if (!Number.isFinite(years) || years < 0) return null
  return years < 1 ? `${Math.floor(years * 12)} months` : `${Math.floor(years)} years`
}

/**
 * One printable page for a panel (FBC, LFT…): every component with its
 * authorised result, pending ones marked as pending (never their values).
 * Generated on request; each component's own report stays the record.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('report.read')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Panel not found' }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const { data: order, error } = await db
    .from('lab_orders')
    .select('id, test_name, panel_code, panel_order_id, accession_number, specimen_id, referral_source, collected_at, patients(full_name, mrn, sex, dob)')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not load the panel' }, { status: 500 })
  if (!order || !order.panel_code || order.panel_order_id) return NextResponse.json({ error: 'Panel not found' }, { status: 404 })
  if (!order.accession_number) return NextResponse.json({ error: 'The panel sample has not been collected yet' }, { status: 409 })

  const { data: components, error: compError } = await db
    .from('lab_orders')
    .select('id, test_name, loinc_code, workflow_status, verified_by, lab_results(result_value, value, unit, reference_range, abnormal_flag, is_critical, version, status)')
    .eq('tenant_id', ctx.tenantId)
    .eq('panel_order_id', id)
    .order('created_at', { ascending: true })
  if (compError) return NextResponse.json({ error: 'Could not load the panel results' }, { status: 500 })

  type Comp = { id: string; test_name: string; loinc_code: string | null; workflow_status: string | null; verified_by: string | null; lab_results?: Array<Record<string, unknown>> | null }
  const list = (components ?? []) as Comp[]
  const verifierIds = [...new Set(list.filter((c) => RELEASED.has(String(c.workflow_status)) && c.verified_by).map((c) => String(c.verified_by)))]
  let authorisedBy: string[] = []
  if (verifierIds.length) {
    const { data: people } = await db.from('profiles').select('id, full_name').in('id', verifierIds).eq('tenant_id', ctx.tenantId)
    authorisedBy = ((people ?? []) as Array<{ full_name: string | null }>).map((p) => p.full_name ?? '').filter(Boolean)
  }

  let specimen: { specimen_type?: string | null; collected_at?: string | null; received_at?: string | null } | null = null
  if (order.specimen_id) {
    const { data } = await db
      .from('lab_specimens')
      .select('specimen_type, collected_at, received_at')
      .eq('id', order.specimen_id)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle()
    specimen = data ?? null
  }
  const html = renderPanelReportHtml({
    panelOrderId: order.id,
    panelCode: order.panel_code,
    panelName: order.test_name,
    accession: order.accession_number,
    facilityName: ctx.facilityName ?? null,
    patientName: order.patients?.full_name ?? null,
    patientMrn: order.patients?.mrn ?? null,
    patientSex: order.patients?.sex ?? null,
    patientAge: age(order.patients?.dob),
    referralSource: order.referral_source ?? null,
    specimenType: specimen?.specimen_type ?? null,
    collectedAt: specimen?.collected_at ?? order.collected_at ?? null,
    receivedAt: specimen?.received_at ?? null,
    authorisedBy,
    generatedAt: new Date().toISOString(),
    rows: list.map((c) => {
      const released = RELEASED.has(String(c.workflow_status))
      const r = [...(c.lab_results ?? [])].sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0]
      return {
        testName: c.test_name,
        loincCode: c.loinc_code,
        released: released && Boolean(r),
        resultValue: released && r ? String(r.result_value ?? r.value ?? '') : null,
        unit: released && r ? ((r.unit as string | null) ?? null) : null,
        referenceRange: released && r ? ((r.reference_range as string | null) ?? null) : null,
        abnormalFlag: released && r ? ((r.abnormal_flag as string | null) ?? null) : null,
        isCritical: released && r ? Boolean(r.is_critical) : false,
        amended: c.workflow_status === 'AMENDED',
      }
    }),
  })
  return new NextResponse(html, { headers: PRINT_HTML_HEADERS })
}
