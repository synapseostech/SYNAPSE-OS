import { NextRequest, NextResponse } from 'next/server'
import { stockTakeReference } from '@synapse/db/stock-take'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'
import {
  STOCK_TAKE_COLUMNS,
  canCountStock,
  canManageStockTake,
  forbidden,
  stockTakeDb,
  toStockTakeView,
  type StockTakeRow,
} from '../../../../../lib/mobile-stock-take'

export const dynamic = 'force-dynamic'

/** Recent stock takes, the open one first. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canCountStock(auth)) return forbidden('Inventory access required')

  const { data, error } = await stockTakeDb()
    .from('pharmacy_stock_takes')
    .select(STOCK_TAKE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .order('opened_at', { ascending: false })
    .limit(20)
  if (error) return NextResponse.json({ error: 'Unable to load stock takes' }, { status: 503 })

  const rows = (data ?? []) as StockTakeRow[]
  const open = rows.find((row) => row.status === 'counting' || row.status === 'review') ?? null
  return NextResponse.json({
    open: open ? toStockTakeView(open, auth) : null,
    stockTakes: rows.map((row) => toStockTakeView(row, auth)),
    canManage: canManageStockTake(auth),
  })
}

/** A manager opens a count. Only one may be open per pharmacy. */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canManageStockTake(auth)) return forbidden('Only a manager can open a stock take')

  const body = (await req.json().catch(() => null)) as {
    title?: unknown
    scope?: unknown
    categories?: unknown
    blind?: unknown
    notes?: unknown
  } | null
  const scope = body?.scope === 'category' ? 'category' : body?.scope === 'all' || body?.scope == null ? 'all' : null
  if (!scope) return NextResponse.json({ error: 'scope must be all or category' }, { status: 400 })

  const categories = Array.isArray(body?.categories)
    ? [...new Set(body.categories.map((c) => String(c ?? '').trim()).filter(Boolean))].slice(0, 50)
    : []
  if (scope === 'category' && categories.length === 0) {
    return NextResponse.json({ error: 'Choose at least one category to count' }, { status: 400 })
  }

  const now = new Date()
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const { count } = await stockTakeDb()
    .from('pharmacy_stock_takes')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', auth.tenantId)
    .gte('opened_at', dayStart.toISOString())
  const reference = stockTakeReference(now, Number(count ?? 0))
  const title =
    String(body?.title ?? '').trim().slice(0, 120) ||
    (scope === 'all' ? 'Full store count' : `Count: ${categories.join(', ')}`)

  const { data, error } = await stockTakeDb()
    .from('pharmacy_stock_takes')
    .insert({
      tenant_id: auth.tenantId,
      reference,
      title,
      scope_type: scope,
      scope_categories: scope === 'category' ? categories : [],
      blind: body?.blind !== false,
      notes: typeof body?.notes === 'string' ? body.notes.trim().slice(0, 500) || null : null,
      opened_by: auth.userId,
      status: 'counting',
    })
    .select(STOCK_TAKE_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        {
          error: 'A stock take is already open. Finish or cancel it first.',
          code: 'STOCK_TAKE_ALREADY_OPEN',
        },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: 'Unable to open stock take' }, { status: 503 })
  }

  await stockTakeDb().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: 'stock_take.open',
    entity: 'pharmacy_stock_takes',
    entity_id: (data as StockTakeRow).id,
    details: JSON.stringify({ reference, scope, categories }),
  })

  return NextResponse.json({ stockTake: toStockTakeView(data as StockTakeRow, auth) }, { status: 201 })
}
