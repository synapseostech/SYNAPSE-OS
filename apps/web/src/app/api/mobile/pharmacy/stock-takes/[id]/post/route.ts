import { NextRequest, NextResponse } from 'next/server'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../../../lib/mobile-pharmacy-auth'
import {
  canManageStockTake,
  forbidden,
  loadStockTake,
  stockTakeDb,
  stockTakeRpcError,
} from '../../../../../../../lib/mobile-stock-take'

export const dynamic = 'force-dynamic'

/**
 * Post the reviewed count. post_pharmacy_stock_take writes every adjustment in
 * one transaction; posting twice returns the first posting's summary.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canManageStockTake(auth)) return forbidden('Only a manager can post a stock take')

  const { id } = await params
  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error
  if (loaded.row.status === 'posted') {
    return NextResponse.json({ ok: true, replay: true, summary: loaded.row.posting_summary })
  }
  if (loaded.row.status !== 'review') {
    return NextResponse.json(
      {
        error: 'Close counting before posting, so no phone is still sending counts.',
        code: 'STOCK_TAKE_NOT_IN_REVIEW',
      },
      { status: 409 },
    )
  }

  const { data, error } = await stockTakeDb().rpc('post_pharmacy_stock_take', {
    p_tenant_id: auth.tenantId,
    p_stock_take_id: id,
    p_actor_id: auth.userId,
  })
  if (error) return stockTakeRpcError(error)

  const summary = (data ?? {}) as Record<string, unknown>
  return NextResponse.json({ ok: true, replay: summary.replay === true, summary })
}
