/**
 * Pure POS sale validation — mirrored from apps/pharmacy for mobile complete-sale.
 */

export type SaleLineInput = {
  productId: string
  quantity: number
  unitPrice?: number
  listPrice?: number
  discountAmount?: number
  discountReason?: string | null
  discountApprovedBy?: string | null
  batchId?: string | null
  batchAllocations?: Array<{
    batchId: string
    quantity: number
    sellingPrice: number
  }>
}

export type CatalogProduct = {
  id: string
  price: number
  is_active?: boolean | null
}

export type SaleLineOk = {
  ok: true
  rpcItem: {
    product_id: string
    quantity: number
    unit_price: number
    list_price: number
    discount_amount: number
    discount_reason: string | null
    discount_approved_by: string | null
    batch_id: string | null
  }
}

export type SaleLineErr = {
  ok: false
  status: number
  error: string
  code?: string
  threshold?: number
}

export function isValidSaleQuantity(quantity: unknown): quantity is number {
  return (
    typeof quantity === 'number' &&
    Number.isFinite(quantity) &&
    Number.isInteger(quantity) &&
    quantity > 0
  )
}

export function validateSaleLine(params: {
  raw: SaleLineInput
  product: CatalogProduct | null
  thresholdPct: number
  isAdmin: boolean
  actorUserId: string
  approvedBy: string | null
}): SaleLineOk | SaleLineErr {
  const { raw, product, thresholdPct, isAdmin, actorUserId, approvedBy } = params

  const productId = String(raw.productId ?? '')
  const quantity = Number(raw.quantity)

  if (!productId || !isValidSaleQuantity(quantity)) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid cart item — quantity must be a positive whole number',
    }
  }

  if (!product || product.is_active === false) {
    return { ok: false, status: 404, error: `Product not found: ${productId}` }
  }

  const listPrice = Number(product.price ?? 0)
  if (!Number.isFinite(listPrice) || listPrice < 0) {
    return { ok: false, status: 400, error: 'Product selling price is invalid' }
  }
  const requestedUnit = Number(raw.unitPrice)
  const discountAmount = Math.max(0, Number(raw.discountAmount ?? 0))
  const discountReason =
    typeof raw.discountReason === 'string' && raw.discountReason.trim()
      ? raw.discountReason.trim()
      : null

  const soldPrice = Number.isFinite(requestedUnit) ? requestedUnit : listPrice
  const impliedDiscount = Math.max(0, (listPrice - soldPrice) * quantity)
  const lineDiscount = discountAmount > 0 ? discountAmount : impliedDiscount
  if (!Number.isFinite(lineDiscount) || lineDiscount > listPrice * quantity + 0.0001) {
    return { ok: false, status: 400, error: 'Discount cannot exceed the line total' }
  }

  if (!isAdmin && Math.abs(soldPrice - listPrice) > 0.0001 && lineDiscount <= 0) {
    return {
      ok: false,
      status: 403,
      error: 'Cashiers cannot change unit price — use discount control',
    }
  }

  if (lineDiscount > 0 && !discountReason) {
    return {
      ok: false,
      status: 400,
      error: 'discount_reason is required when discount_amount is nonzero',
    }
  }

  const discountPct =
    listPrice > 0 && quantity > 0 ? (lineDiscount / (listPrice * quantity)) * 100 : 0

  if (discountPct > thresholdPct && !approvedBy && !isAdmin) {
    return {
      ok: false,
      status: 403,
      error: `Discount ${discountPct.toFixed(1)}% exceeds threshold ${thresholdPct}% — supervisor approval required`,
      code: 'DISCOUNT_APPROVAL_REQUIRED',
      threshold: thresholdPct,
    }
  }

  return {
    ok: true,
    rpcItem: {
      product_id: productId,
      quantity,
      unit_price: listPrice,
      list_price: listPrice,
      discount_amount: lineDiscount,
      discount_reason: discountReason,
      discount_approved_by: approvedBy || (isAdmin ? actorUserId : null),
      batch_id: raw.batchId ?? null,
    },
  }
}

export type PricedBatchAllocation = {
  batchId: string
  quantity: number
  listPrice: number
}

export function splitBatchSaleLine(
  allocations: PricedBatchAllocation[],
  discountAmount: number,
): Array<{ batch_id: string; quantity: number; unit_price: number; discount_amount: number }> {
  const cents = (value: number) => Math.round(value * 100)
  const listTotalCents = allocations.reduce(
    (total, allocation) => total + cents(allocation.quantity * allocation.listPrice),
    0,
  )
  let remainingDiscountCents = cents(discountAmount)

  if (
    allocations.length === 0 ||
    allocations.some(
      (allocation) =>
        !allocation.batchId ||
        !Number.isInteger(allocation.quantity) ||
        allocation.quantity <= 0 ||
        !Number.isFinite(allocation.listPrice) ||
        allocation.listPrice < 0,
    ) ||
    !Number.isFinite(discountAmount) ||
    discountAmount < 0 ||
    remainingDiscountCents > listTotalCents
  ) {
    return []
  }

  let remainingListCents = listTotalCents
  return allocations.map((allocation, index) => {
    const allocationListCents = cents(allocation.quantity * allocation.listPrice)
    const shareCents =
      index === allocations.length - 1
        ? remainingDiscountCents
        : remainingListCents > 0
          ? Math.min(
              allocationListCents,
              Math.round((remainingDiscountCents * allocationListCents) / remainingListCents),
            )
          : 0
    remainingDiscountCents -= shareCents
    remainingListCents -= allocationListCents
    return {
      batch_id: allocation.batchId,
      quantity: allocation.quantity,
      unit_price: allocation.listPrice,
      discount_amount: shareCents / 100,
    }
  })
}

export function extractSaleErrorCode(message: string): string | null {
  const m = message.match(/^([A-Z_]+):/)
  return m?.[1] ?? null
}

export function friendlySaleError(message: string): string {
  if (message.includes('BATCH_PRICE_CHANGED') || message.includes('BATCH_ALLOCATION_CHANGED')) {
    return 'A batch price or allocation changed. Refresh the cart and retry.'
  }
  if (message.includes('EXPIRED_BATCH_BLOCKED')) {
    return 'That batch is expired and cannot be sold. Remove it from the cart and pick another batch.'
  }
  if (message.includes('INSUFFICIENT_STOCK')) {
    return 'Not enough stock on active (non-expired) batches for this sale.'
  }
  if (message.includes('APPEND_ONLY')) {
    return 'Completed sales cannot be edited.'
  }
  return message
}

export function saleErrorHttpStatus(message: string): number {
  if (
    message.includes('EXPIRED_BATCH_BLOCKED') ||
    message.includes('INSUFFICIENT_STOCK') ||
    message.includes('BATCH_PRICE_CHANGED') ||
    message.includes('BATCH_ALLOCATION_CHANGED') ||
    message.includes('APPEND_ONLY')
  ) {
    return 409
  }
  return 500
}
