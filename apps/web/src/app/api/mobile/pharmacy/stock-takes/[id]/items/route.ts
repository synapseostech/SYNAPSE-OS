import { NextRequest, NextResponse } from 'next/server'
import { OVERDRAFT_BATCH_NUMBER } from '@synapse/db/stock-take'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../../../lib/mobile-pharmacy-auth'
import {
  canCountStock,
  forbidden,
  loadBatchesForProducts,
  loadScopeProducts,
  loadStockTake,
  toStockTakeView,
} from '../../../../../../../lib/mobile-stock-take'

export const dynamic = 'force-dynamic'

/**
 * The count sheet a phone downloads once and keeps offline: every product in
 * scope with the batches a counter can pick. Book quantities are left out of a
 * blind count for anyone who cannot manage it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!canCountStock(auth)) return forbidden('Inventory access required')

  const { id } = await params
  const loaded = await loadStockTake(auth.tenantId, id)
  if ('error' in loaded) return loaded.error
  const view = toStockTakeView(loaded.row, auth)

  const products = await loadScopeProducts(loaded.row)
  if ('error' in products) return NextResponse.json({ error: 'Unable to load products' }, { status: 503 })
  const batches = await loadBatchesForProducts(
    auth.tenantId,
    products.rows.map((p) => p.id),
  )
  if ('error' in batches) return NextResponse.json({ error: 'Unable to load batches' }, { status: 503 })

  const byProduct = new Map<string, typeof batches.rows>()
  for (const batch of batches.rows) {
    // The overdraft batch is book-keeping, not something on a shelf.
    if (batch.batch_number === OVERDRAFT_BATCH_NUMBER || Number(batch.quantity ?? 0) < 0) continue
    if (batch.status === 'recalled') continue
    const list = byProduct.get(batch.product_id) ?? []
    list.push(batch)
    byProduct.set(batch.product_id, list)
  }

  const items = products.rows.map((product) => {
    const bookQty = Number(product.quantity ?? 0)
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      category: product.category,
      unit: product.unit_of_measure,
      ...(view.showBook ? { bookQty, negativeBook: bookQty < 0 } : {}),
      batches: (byProduct.get(product.id) ?? []).map((batch) => ({
        id: batch.id,
        batchNumber: batch.batch_number,
        expiryDate: batch.expiry_date,
        status: batch.status ?? 'active',
        ...(view.showBook ? { bookQty: Number(batch.quantity ?? 0) } : {}),
      })),
    }
  })

  return NextResponse.json({
    stockTake: view,
    capturedAt: new Date().toISOString(),
    items,
  })
}
