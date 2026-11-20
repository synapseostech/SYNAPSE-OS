import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'

export const dynamic = 'force-dynamic'

/**
 * Critical results nobody in the lab has acknowledged yet (the phone call to
 * the clinician or patient is the acknowledgement). One query on
 * lab_results_critical_open_idx; the referrer and patient phone come with it.
 */
export async function GET() {
  const ctx = await requireLabAccess('result.read')
  if (isLabContextError(ctx)) return ctx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from('lab_results')
    .select('id, lab_order_id, test_name, result_value, unit, reference_range, abnormal_flag, status, created_at, verified_at, lab_orders(accession_number, section, workflow_status, referral_source, order_source, patients(full_name, mrn, phone))')
    .eq('tenant_id', ctx.tenantId)
    .eq('is_critical', true)
    .is('critical_scientist_ack_at', null)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ critical: data ?? [] })
}
