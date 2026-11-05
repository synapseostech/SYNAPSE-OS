import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { receivePharmacyPurchase } from '@synapse/db/pharmacy-purchases'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
  type MobileAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

function canManagePurchasing(auth: MobileAuth): boolean {
  return mobileHasPharmacyCapability(auth, 'purchasing.manage')
}

function generatePurchaseOrderNo(): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `PO-${timestamp}-${random}`
}

function mapPoItem(item: Record<string, unknown>) {
  return {
    id: String(item.id),
    productId: (item.product_id as string | null) ?? null,
    productName: String(item.product_name ?? ''),
    quantity: Number(item.quantity ?? 0),
    unitPrice: Number(item.unit_price ?? 0),
    totalPrice: Number(item.total_price ?? 0),
  }
}

function mapPurchaseOrder(row: Record<string, unknown>, createdByName?: string | null) {
  const supplierRaw = (row.supplier as Record<string, unknown> | null) ?? null
  const itemsRaw = (row.items as Record<string, unknown>[] | null) ?? []
  return {
    id: String(row.id),
    orderNumber: String(row.order_no ?? ''),
    status: String(row.status ?? 'DRAFT'),
    totalAmount: Number(row.total_amount ?? 0),
    notes: (row.notes as string | null) ?? null,
    expectedDate: (row.expected_date as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
    supplier: {
      id: String(supplierRaw?.id ?? row.supplier_id ?? ''),
      name: String(supplierRaw?.name ?? ''),
      email: (supplierRaw?.email as string | null) ?? null,
      phone: (supplierRaw?.phone as string | null) ?? null,
    },
    items: itemsRaw.map(mapPoItem),
    createdByName: createdByName ?? 'Unknown',
  }
}

/** GET — list purchase orders for the tenant. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!canManagePurchasing(auth)) {
    return NextResponse.json({ error: 'Purchasing permission required' }, { status: 403 })
  }

  const supplierId = new URL(req.url).searchParams.get('supplierId')

  let query = db()
    .from('pharmacy_purchase_orders')
    .select(
      `
      *,
      supplier:pharmacy_suppliers(id, name, email, phone),
      items:pharmacy_purchase_order_items(
        id, product_id, product_name, quantity, unit_price, total_price
      )
    `,
    )
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false })

  if (supplierId) query = query.eq('supplier_id', supplierId)

  const { data: purchaseOrders, error } = await query
  if (error) {
    console.error('[mobile/pharmacy/purchase-orders GET]', error.message)
    return NextResponse.json({ error: 'Failed to load purchase orders' }, { status: 500 })
  }

  const creatorIds = new Set<string>()
  for (const po of purchaseOrders ?? []) {
    if (po.created_by) creatorIds.add(po.created_by)
  }

  const nameMap = new Map<string, string>()
  if (creatorIds.size > 0) {
    const { data: profiles } = await db()
      .from('profiles')
      .select('id, full_name, first_name, last_name')
      .in('id', Array.from(creatorIds))
    for (const p of profiles ?? []) {
      nameMap.set(
        p.id,
        p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ?? p.id,
      )
    }
  }

  return NextResponse.json({
    purchaseOrders: (purchaseOrders ?? []).map((row: Record<string, unknown>) =>
      mapPurchaseOrder(
        row,
        row.created_by ? nameMap.get(String(row.created_by)) ?? 'Unknown' : 'Unknown',
      ),
    ),
  })
}

/** POST — create a purchase order (camelCase body). */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!canManagePurchasing(auth)) {
    return NextResponse.json({ error: 'Purchasing permission required' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as {
    supplierId?: string
    items?: Array<{
      productId?: string
      productName: string
      quantity: number
      unitPrice: number
    }>
    notes?: string
    expectedDate?: string
  } | null

  if (!body?.supplierId || !body.items?.length) {
    return NextResponse.json({ error: 'Supplier and items are required' }, { status: 400 })
  }

  const { data: supplier, error: supplierError } = await db()
    .from('pharmacy_suppliers')
    .select('id, name, email, phone, contact_person')
    .eq('tenant_id', auth.tenantId)
    .eq('id', body.supplierId)
    .maybeSingle()

  if (supplierError || !supplier) {
    return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
  }

  const totalAmount = body.items.reduce(
    (sum, item) => sum + Number(item.quantity) * Number(item.unitPrice),
    0,
  )
  const orderNo = generatePurchaseOrderNo()

  const { data: purchaseOrder, error: poError } = await db()
    .from('pharmacy_purchase_orders')
    .insert({
      tenant_id: auth.tenantId,
      order_no: orderNo,
      supplier_id: body.supplierId,
      total_amount: totalAmount,
      notes: body.notes ?? null,
      expected_date: body.expectedDate ? new Date(body.expectedDate).toISOString() : null,
      created_by: auth.userId,
      status: 'DRAFT',
      email_sent: false,
    })
    .select('id, order_no, status, total_amount, created_at, updated_at, expected_date, notes, supplier_id')
    .single()

  if (poError || !purchaseOrder) {
    console.error('[mobile/pharmacy/purchase-orders POST]', poError?.message)
    return NextResponse.json({ error: 'Failed to create purchase order' }, { status: 500 })
  }

  const poItems = body.items.map((item) => ({
    tenant_id: auth.tenantId,
    purchase_order_id: purchaseOrder.id,
    product_id: item.productId ?? null,
    product_name: item.productName,
    quantity: Number(item.quantity),
    unit_price: Number(item.unitPrice),
    total_price: Number(item.quantity) * Number(item.unitPrice),
  }))

  const { data: insertedItems, error: itemsError } = await db()
    .from('pharmacy_purchase_order_items')
    .insert(poItems)
    .select('id, product_id, product_name, quantity, unit_price, total_price')

  if (itemsError) {
    console.error('[mobile/pharmacy/purchase-orders items]', itemsError.message)
    await db()
      .from('pharmacy_purchase_orders')
      .delete()
      .eq('id', purchaseOrder.id)
      .eq('tenant_id', auth.tenantId)
    return NextResponse.json({ error: 'Failed to create purchase order items' }, { status: 500 })
  }

  await db().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: 'CREATE_PURCHASE_ORDER',
    entity: 'PURCHASE_ORDER',
    entity_id: purchaseOrder.id,
    details: `Created PO ${orderNo} for ${supplier.name} (mobile)`,
  })

  return NextResponse.json({
    ok: true,
    purchaseOrder: mapPurchaseOrder(
      {
        ...(purchaseOrder as Record<string, unknown>),
        supplier: {
          id: supplier.id,
          name: supplier.name,
          email: supplier.email,
          phone: supplier.phone,
        },
        items: insertedItems ?? [],
      },
      'You',
    ),
  })
}

/**
 * PATCH — update status. RECEIVED requires receiptItems with batchNumber+expiryDate
 * and calls receivePharmacyStock (same as portal).
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!canManagePurchasing(auth)) {
    return NextResponse.json({ error: 'Purchasing permission required' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as {
    id?: string
    status?: string
    receiptItems?: Array<{
      productId: string
      /** PO line id — the only way to tell two lines for the same product apart. */
      purchaseOrderItemId?: string
      batchNumber: string
      expiryDate: string
      quantity?: number
      costPrice?: number
    }>
  } | null

  if (!body?.id) {
    return NextResponse.json({ error: 'Purchase order ID required' }, { status: 400 })
  }

  const { data: purchaseOrder, error: poFetchError } = await db()
    .from('pharmacy_purchase_orders')
    .select(
      `
      id, order_no, total_amount, email_sent, status, supplier_id,
      supplier:pharmacy_suppliers(name, email, contact_person),
      items:pharmacy_purchase_order_items(id, product_id, product_name, quantity, unit_price, total_price)
    `,
    )
    .eq('tenant_id', auth.tenantId)
    .eq('id', body.id)
    .maybeSingle()

  if (poFetchError || !purchaseOrder) {
    return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
  }

  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (body.status) updateData.status = body.status

  let receivedSummary: Array<{ productId: string; batchId: string; quantity: number }> = []

  if (body.status === 'RECEIVED') {
    if (purchaseOrder.status === 'RECEIVED') {
      return NextResponse.json({ error: 'Purchase order already received' }, { status: 409 })
    }
    if (purchaseOrder.status === 'CANCELLED') {
      return NextResponse.json(
        { error: 'A cancelled purchase order cannot receive stock.', code: 'PURCHASE_ORDER_CANCELLED' },
        { status: 409 },
      )
    }

    const poItems = (purchaseOrder.items as Array<{
      id: string
      product_id: string | null
      product_name: string
      quantity: number
      unit_price: number
    }>) ?? []

    const linkedItems = poItems.filter((i) => i.product_id)
    if (linkedItems.length === 0) {
      return NextResponse.json(
        { error: 'No product-linked lines to receive. Link products on the PO first.' },
        { status: 400 },
      )
    }

    if (!body.receiptItems?.length) {
      return NextResponse.json(
        {
          error:
            'Receiving a purchase order requires per-line batch numbers and expiry dates.',
          code: 'REQUIRES_BATCH',
          required: linkedItems.map((i) => ({
            productId: i.product_id,
            productName: i.product_name,
            quantity: i.quantity,
          })),
        },
        { status: 400 },
      )
    }

    const lines = (body.receiptItems ?? [])
      .map((receipt) => {
        // Match the PO line, not the product: a PO may list the same product
        // twice, and matching by product sent both receipts to the first line.
        const line = receipt.purchaseOrderItemId
          ? linkedItems.find((item) => item.id === receipt.purchaseOrderItemId)
          : linkedItems.find((item) => item.product_id === receipt.productId)
        if (!line || !(Math.trunc(Number(receipt.quantity ?? line.quantity)) > 0)) return null
        return {
          clientItemId: line.id,
          productId: line.product_id as string,
          productName: line.product_name,
          quantity: Math.trunc(Number(receipt.quantity ?? line.quantity)),
          unitCost: receipt.costPrice ?? line.unit_price,
          batchNumber: receipt.batchNumber,
          expiryDate: receipt.expiryDate,
          purchaseOrderItemId: line.id,
        }
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line))

    const missing = lines.find((line) => !line.batchNumber?.trim() || !line.expiryDate)
    if (missing || lines.length === 0) {
      return NextResponse.json(
        { error: 'Each received line needs a batch number, expiry date, and quantity.', code: 'REQUIRES_BATCH' },
        { status: 400 },
      )
    }

    const result = await receivePharmacyPurchase(db(), {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      supplierId: purchaseOrder.supplier_id,
      supplierInvoiceNo: purchaseOrder.order_no,
      purchaseOrderId: purchaseOrder.id,
      idempotencyKey: `po-receive:${purchaseOrder.id}:${lines.map((l) => `${l.purchaseOrderItemId}:${l.batchNumber}:${l.quantity}`).join('|')}`,
      receiveNow: true,
      lines,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 400 })
    }
    receivedSummary = result.received.map((row) => ({
      productId: row.productId,
      batchId: row.batchId,
      quantity: row.quantity,
    }))
    delete updateData.status
  }

  const { data: updated, error: updateError } = await db()
    .from('pharmacy_purchase_orders')
    .update(updateData)
    .eq('id', body.id)
    .eq('tenant_id', auth.tenantId)
    .select()
    .single()

  if (updateError) {
    console.error('[mobile/pharmacy/purchase-orders PATCH]', updateError.message)
    return NextResponse.json({ error: 'Failed to update purchase order' }, { status: 500 })
  }

  await db().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: 'UPDATE_PURCHASE_ORDER',
    entity: 'PURCHASE_ORDER',
    entity_id: body.id,
    details: `Updated PO ${purchaseOrder.order_no} status to ${
      (updateData.status as string) ?? body.status
    } (mobile)`,
  })

  return NextResponse.json({
    ok: true,
    purchaseOrder: updated
      ? mapPurchaseOrder({
          ...(updated as Record<string, unknown>),
          supplier: purchaseOrder.supplier,
          items: purchaseOrder.items,
        })
      : null,
    received: receivedSummary.length > 0 ? receivedSummary : undefined,
  })
}
