import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, validateSession } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { receivePharmacyStock } from '@synapse/db/inventory-rpc'
import { daysUntilExpiry, kampalaToday } from '@synapse/db/inventory'
import { normaliseExpiry } from '@synapse/db/import-validation'
import {
  isMobileAuth,
  isMobilePharmacyAdmin,
  requireMobilePharmacyAuth,
} from '../../../../lib/mobile-pharmacy-auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const PRODUCT_WRITE_ROLES = new Set([
  'pharmacy_admin',
  'pharmacy_ceo',
  'pharmacist',
  'pharmacy_store_manager',
])

type ItemStatus = 'ok' | 'low' | 'expiring' | 'expired'

function classifyProduct(
  quantity: number,
  reorderLevel: number,
  expiryDate: string | null,
  today: string
): ItemStatus {
  // Calendar days in the business zone, not server-time arithmetic: a dose
  // expiring tomorrow was reading as expiring-today across midnight in Kampala.
  const days = daysUntilExpiry(expiryDate, today)
  if (days !== null) {
    if (days < 0) return 'expired'
    if (days <= 60) return 'expiring'
  }
  if (quantity <= reorderLevel) return 'low'
  return 'ok'
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = await verifyToken(token).catch(() => null)
  if (!payload) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const { valid } = await validateSession(token)
  if (!valid) return NextResponse.json({ error: 'Session expired' }, { status: 401 })

  const tenantId = (payload.tenant_id as string) || ''
  if (!tenantId) {
    return NextResponse.json({
      items: [],
      summary: { totalProducts: 0, lowStock: 0, expiringSoon: 0 },
    })
  }

  // The whole catalogue: a 100-row page hid every product past the first
  // hundred alphabetically and made the counts below describe only that slice.
  const { data: products, error } = await db()
    .from('pharmacy_products')
    .select('id, name, quantity, reorder_level, expiry_date')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: 'Failed to load inventory' }, { status: 500 })
  }

  const today = kampalaToday()
  const items = (products ?? []).map((p: Record<string, unknown>) => {
    const quantity = Number(p.quantity) || 0
    const reorderLevel = Number(p.reorder_level) || 0
    const expiryDate = (p.expiry_date as string | null) ?? null
    const status = classifyProduct(quantity, reorderLevel, expiryDate, today)

    return {
      id: p.id as string,
      name: p.name as string,
      quantity,
      reorderLevel,
      expiryDate,
      status,
    }
  })

  // Surface alerts first: expired → low → expiring → ok
  const priority: Record<ItemStatus, number> = { expired: 0, low: 1, expiring: 2, ok: 3 }
  items.sort((a: { status: ItemStatus }, b: { status: ItemStatus }) =>
    priority[a.status] - priority[b.status]
  )

  const summary = {
    totalProducts: items.length,
    lowStock: items.filter((i: { status: ItemStatus }) => i.status === 'low' || i.status === 'expired').length,
    expiringSoon: items.filter((i: { status: ItemStatus }) => i.status === 'expiring').length,
  }

  return NextResponse.json({ items, summary })
}

/** Create a catalogue product (qty 0); receive sellable stock via RPC when batch provided. */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!PRODUCT_WRITE_ROLES.has(auth.role) && !isMobilePharmacyAdmin(auth)) {
    return NextResponse.json({ error: 'Inventory write requires a manager role' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = String(body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const price = Number(body.price)
  if (!Number.isFinite(price) || price < 0) {
    return NextResponse.json({ error: 'price must be ≥ 0' }, { status: 400 })
  }

  const requestedQty = Math.max(0, Math.floor(Number(body.quantity ?? 0) || 0))
  const reorderLevel = Math.max(0, Math.floor(Number(body.reorderLevel ?? 10) || 10))
  const costPrice = Number(body.costPrice)
  const skuRaw = String(body.sku ?? '').trim()
  const sku =
    skuRaw ||
    `${name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.slice(0, 3).toUpperCase())
      .join('')}-${Date.now().toString(36).slice(-4)}`

  const { data: existing } = await db()
    .from('pharmacy_products')
    .select('id')
    .eq('tenant_id', auth.tenantId)
    .eq('sku', sku)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ error: 'Product with this SKU already exists' }, { status: 400 })
  }

  const batchNumber =
    typeof body.batchNumber === 'string' && body.batchNumber.trim()
      ? body.batchNumber.trim()
      : null
  const expiryRaw =
    typeof body.expiryDate === 'string' && body.expiryDate.trim()
      ? body.expiryDate.trim()
      : null
  const expiryDate = normaliseExpiry(expiryRaw)

  if (requestedQty > 0 && (!batchNumber || !expiryDate)) {
    return NextResponse.json(
      {
        error:
          'Opening stock requires a genuine batch number and future expiry date. Create the product with quantity 0, then receive stock with batch details.',
        code: 'REQUIRES_BATCH',
      },
      { status: 400 },
    )
  }

  const { data: product, error } = await db()
    .from('pharmacy_products')
    .insert({
      tenant_id: auth.tenantId,
      name,
      sku,
      barcode: typeof body.barcode === 'string' && body.barcode.trim() ? body.barcode.trim() : null,
      category:
        typeof body.category === 'string' && body.category.trim()
          ? body.category.trim()
          : 'General',
      price,
      cost_price: Number.isFinite(costPrice) && costPrice >= 0 ? costPrice : 0,
      quantity: 0,
      reorder_level: reorderLevel,
      unit_of_measure:
        typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : 'Tablet',
      batch_number: batchNumber,
      expiry_date: expiryDate,
      requires_prescription: Boolean(body.requiresPrescription),
      is_active: true,
    })
    .select('id, name, sku, quantity, price')
    .single()

  if (error || !product) {
    console.error('[mobile/inventory POST]', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Failed to create' }, { status: 500 })
  }

  let receiveWarning: string | undefined
  if (batchNumber && expiryDate && requestedQty > 0) {
    const { data: received, error: receiveError } = await receivePharmacyStock(db(), {
      tenantId: auth.tenantId,
      productId: product.id,
      batchNumber,
      quantity: requestedQty,
      expiryDate,
      costPrice: Number.isFinite(costPrice) && costPrice >= 0 ? costPrice : 0,
      sellingPrice: price,
      receivedBy: auth.userId,
      reason: 'Mobile product create receive',
    })
    if (receiveError) {
      receiveWarning = receiveError.humanMessage
    } else if (received) {
      product.quantity = received.received
    }
  }

  await db().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: 'CREATE_PRODUCT',
    entity: 'PRODUCT',
    entity_id: product.id,
    details: `Mobile created product: ${product.name} (${product.sku})`,
  })

  return NextResponse.json(
    { ok: true, product, warning: receiveWarning },
    { status: 201 },
  )
}
