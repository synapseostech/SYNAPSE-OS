import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { buildCumulativeResults } from '@/lib/lab/dashboard'

export const dynamic = 'force-dynamic'

/**
 * Cumulative report: every verified result for one patient, grouped by test
 * over time, so a falling Hb or rising creatinine is visible at a glance.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('result.read')
  if (isLabContextError(ctx)) return ctx
  const { id: patientId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) return NextResponse.json({ error: 'Invalid patient id' }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const { data: patient, error: patientError } = await db
    .from('patients')
    .select('id, full_name, mrn, sex, dob, date_of_birth, phone_last4')
    .eq('id', patientId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()
  if (patientError) return NextResponse.json({ error: 'Could not load the patient' }, { status: 500 })
  if (!patient) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  const { data, error } = await db
    .from('lab_results')
    .select('id, lab_order_id, loinc_code, test_name, result_value, value, numeric_value, unit, reference_range, abnormal_flag, is_critical, status, verified_at, created_at')
    .eq('tenant_id', ctx.tenantId)
    .eq('patient_id', patientId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) return NextResponse.json({ error: 'Could not load results' }, { status: 500 })

  return NextResponse.json(
    {
      patient: { id: patient.id, name: patient.full_name, mrn: patient.mrn, sex: patient.sex, dob: patient.dob ?? patient.date_of_birth },
      series: buildCumulativeResults(data ?? []),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
