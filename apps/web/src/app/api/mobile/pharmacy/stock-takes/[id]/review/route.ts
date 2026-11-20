import { NextRequest, NextResponse } from 'next/server'
import {
  kampalaToday,
  parseBatchKey,
  previewStockTakePosting,
  type ReviewCount,
  type ReviewOverride,
} from '@synapse/db/stock-take'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../../../lib/mobile-pharmacy-auth'
import {
  canManageStockTake,
  forbidden,
  loadBatchesForProducts,
  loadScopeProducts,
  loadStockTake,
  selectAll,
  stockTakeDb,
  stockTakeRpcError,
  toStockTakeView,
  type ScopeProductRow,
} from '../../../../../../../lib/mobile-stock-take'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

type CountRow = {
  product_id: string
  batch_key: string
  counted_qty: number
  counted_by: string
  counted_at: string
  new_batch_number: string | null
  new_expiry_date: string | null
}

type OverrideRow = {
  product_id: string
  batch_key: string
  override_qty: number
  reason: string
}

/**
 * Book against counted, per product and batch, with value at cost. What this
 * shows is what posting will write: both follow the rules in
 * packages/db/src/stock-take.ts.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canManageStockTake(auth)) return forbidden('Only a manager can review a stock take')

  const { id } = await params
  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error

  const [counts, overrides, scope] = await Promise.all([
    selectAll<CountRow>(() =>
      stockTakeDb()
        .from('pharmacy_stock_take_counts')
        .select('product_id, batch_key, counted_qty, counted_by, counted_at, new_batch_number, new_expiry_date')
        .eq('tenant_id', auth.tenantId)
        .eq('stock_take_id', id)
        .order('id', { ascending: true }),
    ),
    selectAll<OverrideRow>(() =>
      stockTakeDb()
        .from('pharmacy_stock_take_overrides')
        .select('product_id, batch_key, override_qty, reason')
        .eq('tenant_id', auth.tenantId)
        .eq('stock_take_id', id)
        .order('id', { ascending: true }),
    ),
    loadScopeProducts(loaded.row),
  ])
  if ('error' in counts || 'error' in overrides || 'error' in scope) {
    return NextResponse.json({ error: 'Unable to load the review' }, { status: 503 })
  }

  // Products counted outside the scope (a scan from the wrong shelf) still post.
  const products = new Map<string, ScopeProductRow>(scope.rows.map((p) => [p.id, p]))
  const extraIds = [
    ...new Set([...counts.rows, ...overrides.rows].map((r) => r.product_id).filter((pid) => !products.has(pid))),
  ]
  if (extraIds.length > 0) {
    const { data, error } = await stockTakeDb()
      .from('pharmacy_products')
      .select('id, name, sku, barcode, category, quantity, cost_price, unit_of_measure, updated_at')
      .eq('tenant_id', auth.tenantId)
      .in('id', extraIds)
    if (error) return NextResponse.json({ error: 'Unable to load products' }, { status: 503 })
    for (const row of (data ?? []) as ScopeProductRow[]) products.set(row.id, row)
  }

  const batches = await loadBatchesForProducts(auth.tenantId, [...products.keys()])
  if ('error' in batches) return NextResponse.json({ error: 'Unable to load batches' }, { status: 503 })

  const countsByProduct = new Map<string, ReviewCount[]>()
  for (const row of counts.rows) {
    const list = countsByProduct.get(row.product_id) ?? []
    list.push({
      productId: row.product_id,
      batchKey: row.batch_key,
      countedQty: Number(row.counted_qty),
      countedBy: row.counted_by,
      countedAt: row.counted_at,
      newBatchNumber: row.new_batch_number,
      newExpiryDate: row.new_expiry_date,
    })
    countsByProduct.set(row.product_id, list)
  }
  const overridesByProduct = new Map<string, ReviewOverride[]>()
  for (const row of overrides.rows) {
    const list = overridesByProduct.get(row.product_id) ?? []
    list.push({
      productId: row.product_id,
      batchKey: row.batch_key,
      overrideQty: Number(row.override_qty),
      reason: row.reason,
    })
    overridesByProduct.set(row.product_id, list)
  }

  const review = previewStockTakePosting({
    products: [...products.values()].map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      quantity: Number(p.quantity ?? 0),
      costPrice: p.cost_price == null ? null : Number(p.cost_price),
      updatedAt: p.updated_at,
    })),
    batches: batches.rows.map((b) => ({
      id: b.id,
      productId: b.product_id,
      batchNumber: b.batch_number,
      quantity: Number(b.quantity ?? 0),
      expiryDate: b.expiry_date,
      status: b.status,
      costPrice: b.cost_price == null ? null : Number(b.cost_price),
    })),
    countsByProduct,
    overridesByProduct,
    today: kampalaToday(),
  })

  const counterIds = [...new Set(counts.rows.map((r) => r.counted_by))]
  const names: Record<string, string> = {}
  if (counterIds.length > 0) {
    const { data } = await stockTakeDb()
      .from('profiles')
      .select('id, full_name, first_name, last_name')
      .in('id', counterIds)
    for (const row of (data ?? []) as Array<{
      id: string
      full_name: string | null
      first_name: string | null
      last_name: string | null
    }>) {
      names[row.id] =
        row.full_name?.trim() || [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Staff'
    }
  }

  return NextResponse.json({
    stockTake: toStockTakeView(loaded.row, auth),
    totals: review.totals,
    lines: review.lines,
    counters: names,
  })
}

/** A manager's recount replaces the summed counts for one product and batch. */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canManageStockTake(auth)) return forbidden('Only a manager can recount')

  const { id } = await params
  const body = (await req.json().catch(() => null)) as {
    productId?: unknown
    batchKey?: unknown
    overrideQty?: unknown
    reason?: unknown
  } | null
  const productId = String(body?.productId ?? '').toLowerCase()
  const batchKey = String(body?.batchKey ?? '')
  const parsed = parseBatchKey(batchKey)
  if (!/^[0-9a-f-]{36}$/.test(productId) || !parsed) {
    return NextResponse.json({ error: 'productId and a valid batchKey are required' }, { status: 400 })
  }
  const clearing = body?.overrideQty === null
  const qty = Number(body?.overrideQty)
  if (!clearing && (!Number.isInteger(qty) || qty < 0 || qty > 1_000_000)) {
    return NextResponse.json({ error: 'Recount must be a whole number of zero or more' }, { status: 400 })
  }
  const reason = String(body?.reason ?? '').trim().slice(0, 300)
  if (!clearing && !reason) {
    return NextResponse.json({ error: 'Say why the count is being changed' }, { status: 400 })
  }

  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error
  if (loaded.row.status !== 'counting' && loaded.row.status !== 'review') {
    return NextResponse.json(
      { error: `${loaded.row.reference} is ${loaded.row.status}`, code: 'STOCK_TAKE_CLOSED' },
      { status: 409 },
    )
  }

  const { data: product } = await stockTakeDb()
    .from('pharmacy_products')
    .select('id')
    .eq('tenant_id', auth.tenantId)
    .eq('id', productId)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

  if (parsed.kind === 'batch') {
    const { data: batch } = await stockTakeDb()
      .from('pharmacy_product_batches')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .eq('product_id', productId)
      .eq('id', parsed.batchId)
      .maybeSingle()
    if (!batch) return NextResponse.json({ error: 'Batch not found for this product' }, { status: 404 })
  } else if (parsed.kind === 'new' && !clearing) {
    // A found batch needs its expiry, which only a counter's entry carries.
    const { data: entry } = await stockTakeDb()
      .from('pharmacy_stock_take_counts')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .eq('stock_take_id', id)
      .eq('product_id', productId)
      .eq('batch_key', batchKey)
      .limit(1)
      .maybeSingle()
    if (!entry) {
      return NextResponse.json(
        { error: 'Count the new batch on a phone first, so its expiry is known' },
        { status: 400 },
      )
    }
  }

  if (clearing) {
    const { error } = await stockTakeDb()
      .from('pharmacy_stock_take_overrides')
      .delete()
      .eq('tenant_id', auth.tenantId)
      .eq('stock_take_id', id)
      .eq('product_id', productId)
      .eq('batch_key', batchKey)
    if (error) return stockTakeRpcError(error)
    return NextResponse.json({ ok: true, cleared: true })
  }

  const { error } = await stockTakeDb()
    .from('pharmacy_stock_take_overrides')
    .upsert(
      {
        tenant_id: auth.tenantId,
        stock_take_id: id,
        product_id: productId,
        batch_key: batchKey,
        batch_id: parsed.kind === 'batch' ? parsed.batchId : null,
        override_qty: qty,
        reason,
        set_by: auth.userId,
        set_at: new Date().toISOString(),
      },
      { onConflict: 'stock_take_id,product_id,batch_key' },
    )
  if (error) return stockTakeRpcError(error)

  await stockTakeDb().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: 'stock_take.recount',
    entity: 'pharmacy_stock_takes',
    entity_id: id,
    details: JSON.stringify({ productId, batchKey, overrideQty: qty, reason }),
  })
  return NextResponse.json({ ok: true })
}
