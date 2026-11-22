import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { buildLabDashboard } from '@/lib/lab/dashboard'

export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 14
/** Enough for a busy district lab over two weeks; the response says if it was cut. */
const ROW_CAP = 6000

/**
 * Lab dashboard: work by stage and section, turnaround against each test's
 * target, overdue samples, rejections, volume and open critical values.
 * Three queries, all scoped to the session tenant.
 */
export async function GET() {
  const ctx = await requireLabAccess('order.read')
  if (isLabContextError(ctx)) return ctx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

  const [ordersRes, openRes, catalogRes, criticalRes] = await Promise.all([
    db
      .from('lab_orders')
      .select('id, accession_number, test_name, section, workflow_status, urgency, ordered_at, collected_at, resulted_at, verified_at, rejection_reason, catalog_test_id, order_source, patients(full_name)')
      .eq('tenant_id', ctx.tenantId)
      // One row per sample: a panel's component orders follow the panel order.
      .is('panel_order_id', null)
      .gte('ordered_at', since)
      .order('ordered_at', { ascending: false })
      .limit(ROW_CAP),
    // Older orders that are still open belong on the board too.
    db
      .from('lab_orders')
      .select('id, accession_number, test_name, section, workflow_status, urgency, ordered_at, collected_at, resulted_at, verified_at, rejection_reason, catalog_test_id, order_source, patients(full_name)')
      .eq('tenant_id', ctx.tenantId)
      .is('panel_order_id', null)
      .lt('ordered_at', since)
      .in('workflow_status', ['ORDERED', 'COLLECTION_PENDING', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED', 'PROCESSING', 'RESULT_ENTERED', 'VERIFICATION_PENDING', 'VERIFIED'])
      .limit(500),
    db.from('lab_test_catalog').select('id, turnaround_minutes').eq('tenant_id', ctx.tenantId).limit(1000),
    db
      .from('lab_results')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('is_critical', true)
      .is('critical_scientist_ack_at', null),
  ])
  if (ordersRes.error || openRes.error) {
    return NextResponse.json({ error: 'Could not load lab orders' }, { status: 500 })
  }

  type Row = Record<string, unknown> & { patients?: { full_name?: string | null } | null }
  const rows = [...(ordersRes.data ?? []), ...(openRes.data ?? [])].map((r: Row) => ({
    ...(r as unknown as Parameters<typeof buildLabDashboard>[0]['orders'][number]),
    patient_name: r.patients?.full_name ?? null,
  }))

  const dashboard = buildLabDashboard({
    orders: rows,
    catalog: catalogRes.error ? [] : catalogRes.data ?? [],
    criticalOpen: criticalRes.error ? 0 : criticalRes.count ?? 0,
    windowDays: WINDOW_DAYS,
  })
  return NextResponse.json(
    { ...dashboard, truncated: (ordersRes.data ?? []).length >= ROW_CAP },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
