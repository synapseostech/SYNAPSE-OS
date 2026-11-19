import { NextRequest, NextResponse } from 'next/server'
import {
  batchKeyFor,
  normaliseBatchNumber,
  shouldReplaceCount,
  validateCountEntry,
  type CountEntryInput,
} from '@synapse/db/stock-take'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../../../lib/mobile-pharmacy-auth'
import {
  canCountStock,
  forbidden,
  loadStockTake,
  stockTakeDb,
  stockTakeRpcError,
} from '../../../../../../../lib/mobile-stock-take'

export const dynamic = 'force-dynamic'

const MAX_ENTRIES = 500

type EntryOutcome = {
  entryId: string
  outcome: 'saved' | 'cleared' | 'stale' | 'rejected'
  reason?: string
}

type ExistingRow = {
  id: string
  product_id: string
  batch_key: string
  client_entry_id: string
  counted_at: string
}

/**
 * Upload counts from one phone. Idempotent: every entry carries the id the
 * phone gave it, and per counter and batch the latest countedAt wins, so a
 * phone that was offline for an hour can resend everything safely.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canCountStock(auth)) return forbidden('Inventory access required')

  const { id } = await params
  const body = (await req.json().catch(() => null)) as {
    deviceId?: unknown
    entries?: unknown
  } | null
  const entries = Array.isArray(body?.entries) ? (body.entries as CountEntryInput[]) : null
  if (!entries || entries.length === 0) {
    return NextResponse.json({ error: 'entries are required' }, { status: 400 })
  }
  if (entries.length > MAX_ENTRIES) {
    return NextResponse.json({ error: `Send at most ${MAX_ENTRIES} entries at a time` }, { status: 400 })
  }
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.slice(0, 80) : null

  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error
  if (loaded.row.status !== 'counting') {
    return NextResponse.json(
      {
        error: `Counting has closed for ${loaded.row.reference}. Ask the manager to reopen it.`,
        code: 'STOCK_TAKE_CLOSED',
        status: loaded.row.status,
      },
      { status: 409 },
    )
  }

  const results: EntryOutcome[] = []
  const valid: Array<CountEntryInput & { key: string }> = []
  for (const entry of entries) {
    const reason = validateCountEntry(entry)
    const entryId = String(entry?.entryId ?? '')
    if (reason) {
      results.push({ entryId, outcome: 'rejected', reason })
      continue
    }
    valid.push({
      ...entry,
      entryId: entryId.toLowerCase(),
      productId: entry.productId.toLowerCase(),
      batchId: entry.batchId ? entry.batchId.toLowerCase() : null,
      key: batchKeyFor(entry),
    })
  }

  const productIds = [...new Set(valid.map((e) => e.productId))]
  const batchIds = [...new Set(valid.map((e) => e.batchId).filter(Boolean))] as string[]

  const knownProducts = new Set<string>()
  if (productIds.length > 0) {
    const { data, error } = await stockTakeDb()
      .from('pharmacy_products')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .in('id', productIds)
    if (error) return NextResponse.json({ error: 'Unable to check products' }, { status: 503 })
    for (const row of (data ?? []) as Array<{ id: string }>) knownProducts.add(row.id)
  }
  const batchProduct = new Map<string, string>()
  if (batchIds.length > 0) {
    const { data, error } = await stockTakeDb()
      .from('pharmacy_product_batches')
      .select('id, product_id')
      .eq('tenant_id', auth.tenantId)
      .in('id', batchIds)
    if (error) return NextResponse.json({ error: 'Unable to check batches' }, { status: 503 })
    for (const row of (data ?? []) as Array<{ id: string; product_id: string }>) {
      batchProduct.set(row.id, row.product_id)
    }
  }

  const existing = new Map<string, ExistingRow>()
  if (productIds.length > 0) {
    const { data, error } = await stockTakeDb()
      .from('pharmacy_stock_take_counts')
      .select('id, product_id, batch_key, client_entry_id, counted_at')
      .eq('tenant_id', auth.tenantId)
      .eq('stock_take_id', id)
      .eq('counted_by', auth.userId)
      .in('product_id', productIds)
    if (error) return NextResponse.json({ error: 'Unable to read counts' }, { status: 503 })
    for (const row of (data ?? []) as ExistingRow[]) {
      existing.set(`${row.product_id}|${row.batch_key}`, row)
    }
  }

  // Within one upload the newest entry per key wins as well.
  const latest = new Map<string, CountEntryInput & { key: string }>()
  for (const entry of valid) {
    if (!knownProducts.has(entry.productId)) {
      results.push({ entryId: entry.entryId, outcome: 'rejected', reason: 'Product not found' })
      continue
    }
    if (entry.batchId && batchProduct.get(entry.batchId) !== entry.productId) {
      results.push({ entryId: entry.entryId, outcome: 'rejected', reason: 'Batch not found for this product' })
      continue
    }
    const mapKey = `${entry.productId}|${entry.key}`
    const prior = latest.get(mapKey)
    if (prior && Date.parse(prior.countedAt) > Date.parse(entry.countedAt)) {
      results.push({ entryId: entry.entryId, outcome: 'stale' })
      continue
    }
    if (prior) results.push({ entryId: prior.entryId, outcome: 'stale' })
    latest.set(mapKey, entry)
  }

  const upserts: Record<string, unknown>[] = []
  const upsertIds: string[] = []
  const clears: Array<{ entryId: string; rowId: string }> = []
  for (const [mapKey, entry] of latest) {
    const prior = existing.get(mapKey) ?? null
    const current = prior ? { countedAt: prior.counted_at, entryId: prior.client_entry_id } : null
    if (prior && prior.client_entry_id === entry.entryId) {
      // Replay of what is already stored.
      results.push({ entryId: entry.entryId, outcome: entry.countedQty === null ? 'cleared' : 'saved' })
      continue
    }
    if (!shouldReplaceCount(current, { countedAt: entry.countedAt, entryId: entry.entryId })) {
      results.push({ entryId: entry.entryId, outcome: 'stale' })
      continue
    }
    if (entry.countedQty === null) {
      if (prior) clears.push({ entryId: entry.entryId, rowId: prior.id })
      else results.push({ entryId: entry.entryId, outcome: 'cleared' })
      continue
    }
    upserts.push({
      tenant_id: auth.tenantId,
      stock_take_id: id,
      product_id: entry.productId,
      batch_key: entry.key,
      batch_id: entry.batchId ?? null,
      new_batch_number: entry.newBatchNumber ? normaliseBatchNumber(entry.newBatchNumber) : null,
      new_expiry_date: entry.newBatchNumber ? entry.newExpiryDate ?? null : null,
      counted_qty: entry.countedQty,
      counted_by: auth.userId,
      device_id: deviceId,
      client_entry_id: entry.entryId,
      counted_at: new Date(entry.countedAt).toISOString(),
      received_at: new Date().toISOString(),
      note: typeof entry.note === 'string' ? entry.note.trim().slice(0, 300) || null : null,
    })
    upsertIds.push(entry.entryId)
  }

  if (upserts.length > 0) {
    const { error } = await stockTakeDb()
      .from('pharmacy_stock_take_counts')
      .upsert(upserts, { onConflict: 'stock_take_id,product_id,batch_key,counted_by' })
    // The guard trigger refuses rows if counting closed after the read above.
    if (error) return stockTakeRpcError(error)
    for (const entryId of upsertIds) results.push({ entryId, outcome: 'saved' })
  }

  for (const clear of clears) {
    const { error } = await stockTakeDb()
      .from('pharmacy_stock_take_counts')
      .delete()
      .eq('tenant_id', auth.tenantId)
      .eq('id', clear.rowId)
    if (error) return stockTakeRpcError(error)
    results.push({ entryId: clear.entryId, outcome: 'cleared' })
  }

  return NextResponse.json({ ok: true, results })
}
