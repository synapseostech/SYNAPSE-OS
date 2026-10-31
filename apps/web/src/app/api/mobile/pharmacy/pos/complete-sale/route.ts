import { NextRequest, NextResponse } from 'next/server'
import { gateFeature } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  allocateFefo,
  buildStockError,
  kampalaToday,
  type BatchInput,
  type StructuredStockError,
} from '@synapse/db/inventory'
import {
  isMobileAuth,
  isMobilePharmacyAdmin,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'
import {
  findSaleIdempotency,
  readIdempotencyKey,
  storeSaleIdempotency,
} from '../../../../../../lib/pharmacy-pos/idempotency'
import {
  extractSaleErrorCode,
  friendlySaleError,
  isValidSaleQuantity,
  saleErrorHttpStatus,
  validateSaleLine,
  splitBatchSaleLine,
  type SaleLineInput,
} from '../../../../../../lib/pharmacy-pos/sale-validation'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Complete a POS sale via live `complete_pharmacy_sale` RPC (same as pharmacy portal).
 * Cashier = authenticated mobile user. Catalog list prices enforced server-side.
 */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const gate = await gateFeature(auth.tenantId, 'pos.sell')
  if (gate) return gate

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // A client-supplied patient id is written under the service role and must be
  // proven to belong to the tenant first. Reported as 404 (not 403) so another
  // tenant's patient ids cannot be probed by status code.
  const patientIdRaw =
    typeof body.patientId === 'string' && body.patientId.trim() ? body.patientId.trim() : null
  if (patientIdRaw && !UUID_PATTERN.test(patientIdRaw)) {
    return NextResponse.json(
      { error: 'Invalid patient id', code: 'INVALID_PATIENT_ID' },
      { status: 400 },
    )
  }
  let patientId: string | null = null
  if (patientIdRaw) {
    const { data: patient } = await db()
      .from('patients')
      .select('id')
      .eq('id', patientIdRaw)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle()
    if (!patient?.id) {
      return NextResponse.json({ error: 'Patient not found' }, { status: 404 })
    }
    patientId = patient.id as string
  }

  const idempotencyKey = readIdempotencyKey(req, body)
  if (idempotencyKey) {
    const prior = await findSaleIdempotency(auth.tenantId, idempotencyKey)
    if (prior) {
      return NextResponse.json(
        { ok: true, sale: prior.response, idempotentReplay: true },
        { status: 200, headers: { 'X-Idempotent-Replay': 'true' } },
      )
    }
  }

  const itemsIn = Array.isArray(body.items) ? (body.items as SaleLineInput[]) : []
  if (itemsIn.length === 0) {
    return NextResponse.json({ error: 'Cart is empty' }, { status: 400 })
  }

  const paymentMethod =
    typeof body.paymentMethod === 'string' ? body.paymentMethod.trim() : ''
  if (!paymentMethod) {
    return NextResponse.json({ error: 'paymentMethod is required' }, { status: 400 })
  }

  const { data: settings } = await db()
    .from('pharmacy_settings')
    .select('discount_approval_threshold_pct')
    .eq('tenant_id', auth.tenantId)
    .maybeSingle()

  const threshold = Number(settings?.discount_approval_threshold_pct ?? 5)
  const approvedBy =
    typeof body.discountApprovedBy === 'string' && body.discountApprovedBy
      ? body.discountApprovedBy
      : null

  const isAdmin = isMobilePharmacyAdmin(auth)
  const rpcItems: Record<string, unknown>[] = []

  for (const raw of itemsIn) {
    const productId = String(raw.productId ?? '')
    const { data: product, error: productError } = await db()
      .from('pharmacy_products')
      .select('id, price, name, is_active')
      .eq('id', productId)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle()
    if (productError) {
      console.error('[mobile pos] product lookup failed:', productError)
      return NextResponse.json({ error: 'Could not verify product' }, { status: 500 })
    }

    if (!product || product.is_active === false) {
      return NextResponse.json(
        { error: `Product not found: ${productId}` },
        { status: 404 },
      )
    }

    const quantity = Number(raw.quantity)
    if (!isValidSaleQuantity(quantity)) {
      return NextResponse.json(
        { error: 'Invalid cart item — quantity must be a positive whole number' },
        { status: 400 },
      )
    }
    const { data: batchRows, error: batchError } = await db()
      .from('pharmacy_product_batches')
      .select('id, quantity, expiry_date, status, is_active, selling_price')
      .eq('tenant_id', auth.tenantId)
      .eq('product_id', productId)
    if (batchError) {
      console.error('[mobile pos] batch price lookup failed:', batchError)
      return NextResponse.json({ error: 'Could not verify batch prices' }, { status: 500 })
    }

    const requestedBatchId =
      typeof raw.batchId === 'string' && raw.batchId.trim() ? raw.batchId.trim() : null
    const allocations = allocateFefo((batchRows ?? []) as BatchInput[], quantity, {
      pinBatchId: requestedBatchId,
    })
    const allocatedQuantity = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0)
    if (
      allocatedQuantity !== quantity ||
      allocations.some((allocation) => !allocation.batchId)
    ) {
      return NextResponse.json(
        { error: 'Batch stock changed. Refresh the cart and retry.', code: 'INSUFFICIENT_STOCK' },
        { status: 409 },
      )
    }

    const batchesById = new Map<string, Record<string, unknown>>(
      (batchRows ?? []).map(
        (batch: Record<string, unknown>) => [String(batch.id), batch] as const,
      ),
    )
    const pricedAllocations = allocations.map((allocation) => {
      const batch = batchesById.get(String(allocation.batchId))
      const batchPrice = Number(batch?.selling_price ?? product.price ?? 0)
      return {
        batchId: String(allocation.batchId),
        quantity: allocation.quantity,
        listPrice: batchPrice,
      }
    })
    if (pricedAllocations.some((allocation) => !Number.isFinite(allocation.listPrice) || allocation.listPrice < 0)) {
      console.error('[mobile pos] invalid batch selling price:', { productId })
      return NextResponse.json({ error: 'Could not verify batch prices' }, { status: 500 })
    }

    const listTotal = pricedAllocations.reduce(
      (sum, allocation) => sum + allocation.quantity * allocation.listPrice,
      0,
    )
    const weightedUnitPrice = listTotal / quantity
    const incomingAllocations = raw.batchAllocations
    const suppliedUnitPrice = Number(raw.unitPrice)
    if (incomingAllocations !== undefined) {
      const currentById = new Map(pricedAllocations.map((allocation) => [allocation.batchId, allocation]))
      const snapshot = Array.isArray(incomingAllocations) ? incomingAllocations : []
      const matches =
        snapshot.length === pricedAllocations.length &&
        snapshot.every((entry) => {
          if (!entry || typeof entry !== 'object') return false
          const current = currentById.get(String(entry.batchId))
          return (
            current != null &&
            current.quantity === Number(entry.quantity) &&
            Number.isFinite(Number(entry.sellingPrice)) &&
            Math.abs(current.listPrice - Number(entry.sellingPrice)) < 0.005
          )
        })
      if (
        !matches ||
        !Number.isFinite(Number(raw.listPrice)) ||
        Math.abs(Number(raw.listPrice) - weightedUnitPrice) >= 0.005
      ) {
        return NextResponse.json(
          { error: 'A batch price or allocation changed. Refresh the cart and retry.', code: 'BATCH_PRICE_CHANGED' },
          { status: 409 },
        )
      }
    } else if (
      Number.isFinite(suppliedUnitPrice) &&
      Math.abs(suppliedUnitPrice - weightedUnitPrice) >= 0.005
    ) {
      return NextResponse.json(
        { error: 'A batch selling price changed. Refresh the cart and retry.', code: 'BATCH_PRICE_CHANGED' },
        { status: 409 },
      )
    }

    const line = validateSaleLine({
      raw: {
        ...raw,
        unitPrice: Number.isFinite(suppliedUnitPrice) ? suppliedUnitPrice : weightedUnitPrice,
      },
      product: { id: product.id, price: weightedUnitPrice, is_active: product.is_active },
      thresholdPct: threshold,
      isAdmin,
      actorUserId: auth.userId,
      approvedBy,
    })
    if (!line.ok) {
      return NextResponse.json(
        {
          error: line.error,
          ...(line.code ? { code: line.code } : {}),
          ...(line.threshold != null ? { threshold: line.threshold } : {}),
        },
        { status: line.status },
      )
    }
    const splitItems = splitBatchSaleLine(
      pricedAllocations,
      line.rpcItem.discount_amount,
    )
    if (splitItems.length !== pricedAllocations.length) {
      return NextResponse.json(
        { error: 'Discount exceeds the batch-priced line total', code: 'INVALID_DISCOUNT' },
        { status: 400 },
      )
    }
    for (const item of splitItems) {
      rpcItems.push({
        ...line.rpcItem,
        ...item,
        list_price: item.unit_price,
      })
    }
  }

  const saleAmount = rpcItems.reduce(
    (sum, item) =>
      sum +
      Number(item.unit_price ?? 0) * Number(item.quantity ?? 0) -
      Number(item.discount_amount ?? 0),
    0,
  )
  const { attachSaleToTill, recordTillSale } = await import('@synapse/db/till-service')
  const { httpStatusForPharmacyError } = await import('@synapse/db/errors')
  const till = await attachSaleToTill({
    tenantId: auth.tenantId,
    cashierId: auth.userId,
    paymentMethod,
    // Attach to the open till when there is one; cash is credited after the sale
    // commits (recordTillSale). Optional, so a sale never blocks on a closed till.
    amount: 0,
    kind: 'sale',
    required: false,
  })
  if (!till.ok) {
    return NextResponse.json(till.error, { status: httpStatusForPharmacyError(till.error.code) })
  }

  // Line discounts are already on each rpc item. Passing the same sum as
  // p_discount_total double-counts inside complete_pharmacy_sale.
  const { data, error } = await db().rpc('complete_pharmacy_sale', {
    p_tenant_id: auth.tenantId,
    p_cashier_id: auth.userId,
    p_items: rpcItems,
    p_payment_method: paymentMethod,
    p_session_id: till.sessionId ?? body.sessionId ?? null,
    p_cart_id: body.cartId ?? null,
    p_payment_ref: body.paymentRef ?? null,
    p_discount_total: 0,
    p_tax_amount: Number(body.taxAmount ?? 0),
    p_patient_id: patientId,
    p_confirmed_by: auth.userId,
    // Always named: an older 11-argument overload still exists, so omitting it is ambiguous.
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    const msg = error.message ?? 'Sale failed'
    const code = extractSaleErrorCode(msg)
    // Enrich stock failures with the structured POS error contract so the app
    // can guide the cashier (productId, sellableQuantity, reasonCode, action).
    let stockError: StructuredStockError | null = null
    if (code === 'INSUFFICIENT_STOCK' || code === 'EXPIRED_BATCH_BLOCKED') {
      stockError = await buildStructuredStockError(auth.tenantId, rpcItems)
    }
    return NextResponse.json(
      {
        error: friendlySaleError(msg),
        code,
        ...(stockError ? { stockError } : {}),
      },
      { status: saleErrorHttpStatus(msg) },
    )
  }

  const committed = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (till.sessionId) {
    const tax = Number(body.taxAmount ?? 0)
    try {
      await recordTillSale({
        tenantId: auth.tenantId,
        sessionId: till.sessionId,
        paymentMethod,
        amount: Number(committed.total_amount ?? saleAmount + (Number.isFinite(tax) ? tax : 0)),
        saleId: String(committed.sale_id ?? committed.id ?? '') || null,
        actorId: auth.userId,
      })
    } catch (err) {
      console.error('[mobile pos] till cash record failed:', err)
    }
  }

  const responseBody = { ok: true as const, sale: data, lowStock: [] as Array<{
    id: string
    name: string
    quantity: number
    reorderLevel: number
  }> }

  // Surface reorder crossings in the response (also pushed async below).
  try {
    const productIds = [...new Set(rpcItems.map((i) => String(i.product_id)))]
    if (productIds.length > 0) {
      const { data: products } = await db()
        .from('pharmacy_products')
        .select('id, name, quantity, reorder_level')
        .eq('tenant_id', auth.tenantId)
        .in('id', productIds)
      responseBody.lowStock = (products ?? [])
        .filter(
          (p: { quantity?: number; reorder_level?: number }) =>
            Number(p.reorder_level ?? 0) > 0 &&
            Number(p.quantity ?? 0) <= Number(p.reorder_level ?? 0),
        )
        .map((p: { id: string; name: string; quantity?: number; reorder_level?: number }) => ({
          id: p.id,
          name: p.name,
          quantity: Number(p.quantity ?? 0),
          reorderLevel: Number(p.reorder_level ?? 0),
        }))
    }
  } catch {
    // non-fatal
  }

  if (idempotencyKey) {
    const saleId =
      data && typeof data === 'object'
        ? String(
            (data as { sale_id?: unknown; id?: unknown }).sale_id ??
              (data as { id?: unknown }).id ??
              '',
          ) || null
        : null
    await storeSaleIdempotency({
      tenantId: auth.tenantId,
      key: idempotencyKey,
      userId: auth.userId,
      saleId,
      response: data,
    })
  }

  void (async () => {
    try {
      const productIds = [...new Set(rpcItems.map((i) => String(i.product_id)))]
      if (productIds.length === 0) return
      const { data: products } = await db()
        .from('pharmacy_products')
        .select('id, name, quantity, reorder_level')
        .eq('tenant_id', auth.tenantId)
        .in('id', productIds)
      const low = (products ?? []).filter(
        (p: { quantity?: number; reorder_level?: number }) =>
          Number(p.reorder_level ?? 0) > 0 &&
          Number(p.quantity ?? 0) <= Number(p.reorder_level ?? 0),
      )
      if (low.length === 0) return
      const { notifyPharmacyStock } = await import('@synapse/auth/mobile-push')
      for (const p of low.slice(0, 5)) {
        notifyPharmacyStock({
          tenantId: auth.tenantId,
          productName: p.name,
          reason: 'reorder',
          detail: `${p.name} is at ${p.quantity} (reorder ${p.reorder_level}).`,
        })
      }
    } catch (err) {
      console.error('[mobile/pos] reorder push failed:', err)
    }
  })()

  return NextResponse.json(responseBody)
}

/**
 * Recompute the authoritative batch-derived stock picture for the requested lines and
 * return the first line that cannot be fully satisfied as a structured POS error.
 * Best-effort: returns null if the catalogue cannot be re-read.
 */
async function buildStructuredStockError(
  tenantId: string,
  rpcItems: Record<string, unknown>[],
): Promise<StructuredStockError | null> {
  try {
    const productIds = [...new Set(rpcItems.map((i) => String(i.product_id)))]
    if (productIds.length === 0) return null
    const { data: products } = await db()
      .from('pharmacy_products')
      .select(
        `id, name, quantity, is_active,
         pharmacy_product_batches(id, batch_number, quantity, expiry_date, is_active, manufacturer)`,
      )
      .eq('tenant_id', tenantId)
      .in('id', productIds)

    const byId = new Map<string, Record<string, unknown>>()
    for (const p of products ?? []) byId.set(String(p.id), p)

    for (const item of rpcItems) {
      const pid = String(item.product_id)
      const requested = Number(item.quantity ?? 0)
      const product = byId.get(pid)
      const err = buildStockError({
        product: product
          ? { id: pid, name: String(product.name ?? ''), quantity: product.quantity as number, is_active: product.is_active as boolean }
          : { id: pid, name: 'Unknown product', quantity: 0 },
        batches: (product?.pharmacy_product_batches as Array<Record<string, unknown>>) ?? [],
        requestedQuantity: requested,
      })
      if (err) return err
    }
    return null
  } catch {
    return null
  }
}
