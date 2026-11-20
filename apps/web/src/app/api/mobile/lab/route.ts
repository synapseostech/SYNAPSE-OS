import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isLabContextError, requireLabAccessFromRequest } from '@/lib/lab/access'
import { fetchLabWorklist, LAB_VIEWS } from '@/lib/lab/worklist'

export const dynamic = 'force-dynamic'

/**
 * APK lab tab and result look-up.
 *
 *   GET /api/mobile/lab                 open orders, newest first, with counts
 *   GET /api/mobile/lab?q=LAB-2026…     look a specimen up by accession, or a
 *                                       patient by name / number
 *   GET /api/mobile/lab?view=released   released results
 *   &cursor=…                           next page
 *
 * This used to read the legacy encounter_orders table with no capability
 * check, so any account with a tenant token could list patients' lab orders
 * and none of the real lab flow showed. It now reads lab_orders behind
 * lab.order.read (one access call) like the web console.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireLabAccessFromRequest(req, 'order.read')
  if (isLabContextError(ctx)) return ctx

  const params = req.nextUrl.searchParams
  const q = params.get('q')?.trim() || null
  const view = params.get('view') ?? (q ? 'all' : 'open')
  const cursor = params.get('cursor')
  const { orders, nextCursor, error } = await fetchLabWorklist(ctx, {
    view,
    q,
    cursor,
    section: params.get('section'),
    limit: Number(params.get('limit')) || 30,
  })
  if (error) return NextResponse.json({ error: 'Failed to load lab orders' }, { status: 500 })

  // Counts only on the first, unfiltered page: three head-only counts in parallel.
  let stats: { pending: number; inProgress: number; collected: number } | null = null
  if (!q && !cursor) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const count = (statuses: readonly string[]) =>
      db.from('lab_orders').select('id', { count: 'exact', head: true })
        .eq('tenant_id', ctx.tenantId).eq('is_synthetic', false).in('workflow_status', [...statuses])
        .then((r: { count: number | null }) => r.count ?? 0)
    const [pending, collected, inProgress] = await Promise.all([
      count(LAB_VIEWS.collection),
      count(LAB_VIEWS.reception),
      count([...LAB_VIEWS.bench, ...LAB_VIEWS.verify]),
    ])
    stats = { pending, inProgress, collected }
  }

  return NextResponse.json(
    {
      orders: orders.map((o) => ({
        id: o.id,
        patientName: o.patientName ?? 'Unknown patient',
        patientMrn: o.synapseId,
        testName: o.testName,
        section: o.section,
        status: o.status,
        urgency: o.urgency,
        accessionNumber: o.accessionNumber,
        orderedAt: o.orderedAt,
        orderedBy: null,
        // Values are shown only once a senior has released them.
        result: ['RELEASED', 'AMENDED'].includes(o.status) && o.hasResult
          ? { value: o.resultValue, unit: o.unit, referenceRange: o.referenceRange, flag: o.flag, isCritical: o.isCritical }
          : null,
      })),
      stats: stats ?? { pending: 0, inProgress: 0, collected: 0 },
      nextCursor,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
