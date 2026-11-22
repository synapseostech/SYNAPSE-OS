import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { renderRadiologyReportHtml } from '@synapse/db/radiology'
import { isContextError, requireHospitalCapability } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

const PRINT_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

function age(dob: string | null | undefined): string | null {
  if (!dob) return null
  const y = (Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000)
  if (!Number.isFinite(y) || y < 0) return null
  return y < 1 ? `${Math.floor(y * 12)} months` : `${Math.floor(y)} years`
}

/**
 * Printable radiology report. Clinicians (encounter authors) see only
 * verified reports; imaging staff (radiology.order.read) also see drafts,
 * marked PRELIMINARY.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx
  const imagingStaff = (await requireHospitalCapability(ctx, 'order', 'read', 'radiology')) == null
  if (!imagingStaff) {
    const clinician = await requireHospitalCapability(ctx, 'encounter', 'create', 'opd')
    if (clinician) return clinician
  }
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: s, error } = await db
    .from('imaging_studies')
    .select('id, accession_number, modality, body_part, laterality, study_description, clinical_indication, worklist_status, created_at, patients(full_name, mrn, sex, dob), radiology_reports(technique, findings, impression, recommendation, is_critical, status, radiographer_id, radiologist_id, reported_at, updated_at)')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .eq('is_deleted', false)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not load the report' }, { status: 500 })
  const report = Array.isArray(s?.radiology_reports) ? s.radiology_reports[0] : s?.radiology_reports
  const verified = s?.worklist_status === 'verified'
  if (!s || !report || (!verified && !imagingStaff)) return NextResponse.json({ error: 'Report not found' }, { status: 404 })

  const ids = [report.radiographer_id, report.radiologist_id].filter(Boolean)
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: people } = await db.from('profiles').select('id, full_name').in('id', ids).eq('tenant_id', ctx.tenantId)
    for (const p of (people ?? []) as Array<{ id: string; full_name: string | null }>) if (p.full_name) names.set(p.id, p.full_name)
  }
  const { data: facility } = await db.from('hospitals').select('name').eq('id', ctx.hospitalId).maybeSingle()
  const html = renderRadiologyReportHtml({
    facilityName: facility?.name ?? null,
    accession: s.accession_number,
    examName: s.study_description ?? s.modality,
    modality: s.modality,
    bodyPart: s.body_part,
    laterality: s.laterality,
    patientName: s.patients?.full_name ?? null,
    patientMrn: s.patients?.mrn ?? null,
    patientSex: s.patients?.sex ?? null,
    patientAge: age(s.patients?.dob),
    clinicalIndication: s.clinical_indication,
    requestedAt: s.created_at,
    technique: report.technique,
    findings: report.findings,
    impression: report.impression,
    recommendation: report.recommendation,
    isCritical: Boolean(report.is_critical),
    verified,
    reportedByName: names.get(report.radiographer_id) ?? null,
    verifiedByName: verified ? names.get(report.radiologist_id) ?? null : null,
    reportedAt: report.reported_at ?? report.updated_at,
  })
  return new NextResponse(html, { headers: PRINT_HEADERS })
}
