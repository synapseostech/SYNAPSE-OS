import { NextResponse } from 'next/server'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { loadLabOrderBundle } from '@/lib/lab/engine'
import { PRINT_HTML_HEADERS, renderSpecimenLabels } from '@/lib/lab/label'
import { supabaseAdmin } from '@synapse/db/admin'

export const dynamic = 'force-dynamic'

/** Printable barcode label(s) for a collected specimen. ?copies=1..6 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('specimen.collect')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  const bundle = await loadLabOrderBundle(supabaseAdmin, ctx, id).catch(() => null)
  if (!bundle) return NextResponse.json({ error: 'Lab order not found' }, { status: 404 })
  const accession = (bundle.order.accession_number as string | null) ?? (bundle.specimen?.accession_number as string | null)
  if (!accession) return NextResponse.json({ error: 'Collect the specimen first: it has no accession number yet' }, { status: 409 })
  const html = renderSpecimenLabels({
    accession,
    patientName: bundle.patient?.fullName ?? null,
    patientMrn: bundle.patient?.mrn ?? null,
    sex: bundle.patient?.sex ?? null,
    dob: bundle.patient?.dob ?? null,
    testName: String(bundle.order.test_name),
    section: (bundle.order.section as string | null) ?? null,
    specimenType: (bundle.specimen?.specimen_type as string | null) ?? null,
    container: (bundle.specimen?.container as string | null) ?? (bundle.catalog?.container as string | null) ?? null,
    collectedAt: (bundle.specimen?.collected_at as string | null) ?? null,
    urgency: String(bundle.order.urgency ?? 'ROUTINE'),
  }, Number(new URL(request.url).searchParams.get('copies')) || 1)
  return new NextResponse(html, { headers: PRINT_HTML_HEADERS })
}
