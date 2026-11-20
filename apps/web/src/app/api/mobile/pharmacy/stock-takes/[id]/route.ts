import { NextRequest, NextResponse } from 'next/server'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'
import {
  STOCK_TAKE_COLUMNS,
  canCountStock,
  canManageStockTake,
  forbidden,
  loadStockTake,
  selectAll,
  stockTakeDb,
  toStockTakeView,
  type StockTakeRow,
} from '../../../../../../lib/mobile-stock-take'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** The session and how far the count has got. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canCountStock(auth)) return forbidden('Inventory access required')

  const { id } = await params
  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error

  const counts = await selectAll<{ product_id: string; counted_by: string }>(() =>
    stockTakeDb()
      .from('pharmacy_stock_take_counts')
      .select('product_id, counted_by')
      .eq('tenant_id', auth.tenantId)
      .eq('stock_take_id', id)
      .order('id', { ascending: true }),
  )
  if ('error' in counts) return NextResponse.json({ error: 'Unable to load counts' }, { status: 503 })

  const products = new Set<string>()
  const mine = new Set<string>()
  const counters = new Map<string, Set<string>>()
  for (const row of counts.rows) {
    products.add(row.product_id)
    if (row.counted_by === auth.userId) mine.add(row.product_id)
    const set = counters.get(row.counted_by) ?? new Set<string>()
    set.add(row.product_id)
    counters.set(row.counted_by, set)
  }

  return NextResponse.json({
    stockTake: toStockTakeView(loaded.row, auth),
    progress: {
      productsCounted: products.size,
      myProductsCounted: mine.size,
      counters: [...counters.entries()].map(([profileId, set]) => ({
        profileId,
        products: set.size,
        isMe: profileId === auth.userId,
      })),
    },
  })
}

const TRANSITIONS: Record<string, { from: string[]; to: string; stamp: Record<string, 'now' | 'actor' | null> }> = {
  close: { from: ['counting'], to: 'review', stamp: { closed_at: 'now', closed_by: 'actor' } },
  reopen: { from: ['review'], to: 'counting', stamp: { closed_at: null, closed_by: null } },
  cancel: { from: ['counting', 'review'], to: 'cancelled', stamp: { cancelled_at: 'now', cancelled_by: 'actor' } },
}

/** Close counting for review, reopen it, or cancel the take. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canManageStockTake(auth)) return forbidden('Only a manager can change a stock take')

  const { id } = await params
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null
  const action = typeof body?.action === 'string' ? body.action : ''
  const transition = TRANSITIONS[action]
  if (!transition) {
    return NextResponse.json({ error: 'action must be close, reopen or cancel' }, { status: 400 })
  }

  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error
  if (!transition.from.includes(loaded.row.status)) {
    return NextResponse.json(
      { error: `Cannot ${action} a stock take that is ${loaded.row.status}`, code: 'STOCK_TAKE_STATUS' },
      { status: 409 },
    )
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: transition.to }
  for (const [column, value] of Object.entries(transition.stamp)) {
    patch[column] = value === 'now' ? now : value === 'actor' ? auth.userId : null
  }
  // The status filter makes the transition a compare-and-set: two managers
  // pressing at once get one success and one 409.
  const { data, error } = await stockTakeDb()
    .from('pharmacy_stock_takes')
    .update(patch)
    .eq('tenant_id', auth.tenantId)
    .eq('id', id)
    .eq('status', loaded.row.status)
    .select(STOCK_TAKE_COLUMNS)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Unable to update stock take' }, { status: 503 })
  if (!data) {
    return NextResponse.json(
      { error: 'The stock take changed meanwhile. Refresh and try again.', code: 'STOCK_TAKE_STATUS' },
      { status: 409 },
    )
  }

  await stockTakeDb().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: `stock_take.${action}`,
    entity: 'pharmacy_stock_takes',
    entity_id: id,
    details: JSON.stringify({ reference: loaded.row.reference, from: loaded.row.status, to: transition.to }),
  })

  return NextResponse.json({ stockTake: toStockTakeView(data as StockTakeRow, auth) })
}
