import { NextRequest, NextResponse } from 'next/server'
import { gateFeature } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { summarizeInventory, kampalaToday, normaliseBatch, isSellableBatch } from '@synapse/db/inventory'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/** POS catalog: sellable products with price + packages + FEFO batches. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const gate = await gateFeature(auth.tenantId, 'pos.sell')
  if (gate) return gate

  const q = new URL(req.url).searchParams.get('q')?.trim().toLowerCase() ?? ''
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? '80'), 150)

  const { data: products, error } = await db()
    .from('pharmacy_products')
    .select(
      `
      id, name, sku, barcode, price, cost_price, quantity, unit_of_measure,
      requires_prescription, is_active,
      pharmacy_product_packages(id, name, units_per_package, price, is_default),
      pharmacy_product_batches(id, batch_number, quantity, expiry_date, cost_price, selling_price, is_active, status, manufacturer)
    `,
    )
    .eq('tenant_id', auth.tenantId)
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(q ? 200 : limit)

  if (error) {
    console.error('[mobile/pharmacy/pos/products]', error.message)
    return NextResponse.json({ error: 'Failed to load products' }, { status: 500 })
  }

  let rows = products ?? []
  if (q) {
    rows = rows.filter((p: { name?: string; sku?: string; barcode?: string }) => {
      const name = String(p.name ?? '').toLowerCase()
      const sku = String(p.sku ?? '').toLowerCase()
      const barcode = String(p.barcode ?? '').toLowerCase()
      return name.includes(q) || sku.includes(q) || barcode.includes(q)
    }).slice(0, limit)
  }

  const today = kampalaToday()
  return NextResponse.json({
    products: rows.map((product: Record<string, unknown>) => {
      const packages = (product.pharmacy_product_packages as Array<Record<string, unknown>> | null) ?? []
      const batches = (product.pharmacy_product_batches as Array<Record<string, unknown>> | null) ?? []
      // Authoritative, batch-derived quantities. `quantity` (product-level) is kept for
      // backwards compatibility but POS must validate against `sellableQuantity`.
      const summary = summarizeInventory(
        {
          id: String(product.id),
          name: String(product.name ?? ''),
          quantity: product.quantity as number,
          is_active: product.is_active as boolean,
        },
        batches,
        today,
      )
      return {
        id: product.id,
        name: product.name,
        sku: product.sku ?? null,
        barcode: product.barcode ?? null,
        price: Number(product.price ?? 0),
        costPrice: product.cost_price != null ? Number(product.cost_price) : null,
        quantity: Number(product.quantity ?? 0),
        sellableQuantity: summary.sellableQuantity,
        physicalQuantity: summary.physicalQuantity,
        expiredQuantity: summary.expiredQuantity,
        unbatchedQuantity: summary.unbatchedQuantity,
        hasPhantomStock: summary.hasPhantomStock,
        unit: product.unit_of_measure ?? 'unit',
        requiresPrescription: Boolean(product.requires_prescription),
        packages: packages
          .sort(
            (a, b) =>
              Number(a.units_per_package ?? 0) - Number(b.units_per_package ?? 0),
          )
          .map((pkg) => ({
            id: pkg.id,
            name: pkg.name,
            unitsPerPackage: Number(pkg.units_per_package ?? 1),
            price: Number(pkg.price ?? 0),
            isDefault: Boolean(pkg.is_default),
          })),
        batches: batches
          .filter((b) => isSellableBatch(normaliseBatch(b, today), today))
          .sort(
            (a, b) =>
              new Date(String(a.expiry_date)).getTime() -
              new Date(String(b.expiry_date)).getTime(),
          )
          .map((batch) => ({
            id: batch.id,
            batchNumber: batch.batch_number,
            quantity: Number(batch.quantity ?? 0),
            expiryDate: batch.expiry_date,
            sellingPrice: Number(batch.selling_price ?? product.price ?? 0),
            costPrice: batch.cost_price != null ? Number(batch.cost_price) : null,
          })),
      }
    }),
  })
}
