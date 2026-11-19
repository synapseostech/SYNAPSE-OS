/**
 * Physical stock-take: the rules both the mobile API and the APK use.
 *
 * `previewStockTakePosting` mirrors `post_pharmacy_stock_take`
 * (supabase/migrations/20261118120000_pharmacy_stock_take.sql), so the review
 * screen shows the manager exactly what posting will write. Change one, change
 * the other.
 */

export type StockTakeStatus = 'counting' | 'review' | 'posted' | 'cancelled'
export type StockTakeScope = 'all' | 'category'

export const UNBATCHED_KEY = 'unbatched'
export const NEW_BATCH_PREFIX = 'new:'
/** The overdraft batch complete_pharmacy_sale creates when stock runs below zero. */
export const OVERDRAFT_BATCH_NUMBER = 'NEG-STOCK'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const MAX_COUNT_QTY = 1_000_000

export function normaliseBatchNumber(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

/** The key one counted line is stored under. */
export function batchKeyFor(entry: { batchId?: string | null; newBatchNumber?: string | null }): string {
  if (entry.batchId) return entry.batchId.toLowerCase()
  if (entry.newBatchNumber && entry.newBatchNumber.trim()) {
    return `${NEW_BATCH_PREFIX}${normaliseBatchNumber(entry.newBatchNumber)}`
  }
  return UNBATCHED_KEY
}

export type ParsedBatchKey =
  | { kind: 'batch'; batchId: string }
  | { kind: 'unbatched' }
  | { kind: 'new'; batchNumber: string }

export function parseBatchKey(key: string): ParsedBatchKey | null {
  if (key === UNBATCHED_KEY) return { kind: 'unbatched' }
  if (key.startsWith(NEW_BATCH_PREFIX)) {
    const batchNumber = key.slice(NEW_BATCH_PREFIX.length)
    return batchNumber.trim() ? { kind: 'new', batchNumber } : null
  }
  return UUID_RE.test(key) ? { kind: 'batch', batchId: key } : null
}

export type CountEntryInput = {
  entryId: string
  productId: string
  batchId?: string | null
  newBatchNumber?: string | null
  newExpiryDate?: string | null
  countedQty: number | null
  countedAt: string
  note?: string | null
}

/** Null when the entry is acceptable; otherwise the reason it is not. */
export function validateCountEntry(entry: CountEntryInput): string | null {
  if (!entry || typeof entry !== 'object') return 'Entry must be an object'
  if (!UUID_RE.test(String(entry.entryId ?? '').toLowerCase())) return 'entryId must be a UUID'
  if (!UUID_RE.test(String(entry.productId ?? '').toLowerCase())) return 'productId must be a UUID'
  if (entry.batchId != null && !UUID_RE.test(String(entry.batchId).toLowerCase())) {
    return 'batchId must be a UUID'
  }
  if (entry.batchId && entry.newBatchNumber) return 'Give a batch id or a new batch number, not both'
  if (entry.countedQty !== null) {
    if (typeof entry.countedQty !== 'number' || !Number.isInteger(entry.countedQty)) {
      return 'Counted quantity must be a whole number'
    }
    if (entry.countedQty < 0) return 'Counted quantity cannot be below zero'
    if (entry.countedQty > MAX_COUNT_QTY) return 'Counted quantity is too large'
  }
  if (entry.newBatchNumber != null) {
    const number = normaliseBatchNumber(String(entry.newBatchNumber))
    if (!number) return 'New batch number is empty'
    if (number.length > 60) return 'New batch number is too long'
    if (number === OVERDRAFT_BATCH_NUMBER) return 'NEG-STOCK is not a real batch'
    if (entry.countedQty !== null && !isValidIsoDate(entry.newExpiryDate)) {
      return 'A new batch needs an expiry date (YYYY-MM-DD)'
    }
  }
  if (!Number.isFinite(Date.parse(String(entry.countedAt ?? '')))) return 'countedAt must be a timestamp'
  return null
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Last write wins per counter and key. A replayed or older entry from a phone
 * that was offline must not overwrite a newer count from the same person.
 */
export function shouldReplaceCount(
  existing: { countedAt: string; entryId: string } | null,
  incoming: { countedAt: string; entryId: string },
): boolean {
  if (!existing) return true
  if (existing.entryId === incoming.entryId) return false
  return Date.parse(incoming.countedAt) >= Date.parse(existing.countedAt)
}

// ---------------------------------------------------------------------------
// Posting preview
// ---------------------------------------------------------------------------

export type ReviewBatch = {
  id: string
  batchNumber: string
  quantity: number
  expiryDate: string | null
  status: string | null
  costPrice: number | null
}

export type ReviewProduct = {
  id: string
  name: string
  sku: string | null
  category: string | null
  quantity: number
  costPrice: number | null
}

export type ReviewCount = {
  productId: string
  batchKey: string
  countedQty: number
  countedBy: string
  countedAt: string
  newBatchNumber?: string | null
  newExpiryDate?: string | null
}

export type ReviewOverride = {
  productId: string
  batchKey: string
  overrideQty: number
  reason: string
}

export type PostingRule =
  | 'counted'
  | 'negative_cleared'
  | 'uncounted_share'
  | 'count_batch'
  | 'new_batch'
  | 'unchanged'

export type ReviewBatchLine = {
  batchKey: string
  batchId: string | null
  batchNumber: string
  expiryDate: string | null
  status: string | null
  bookQty: number
  countedQty: number | null
  counters: Array<{ countedBy: string; countedQty: number; countedAt: string }>
  overrideQty: number | null
  overrideReason: string | null
  finalQty: number
  variance: number
  unitCost: number
  varianceValue: number
  rule: PostingRule
}

export type ReviewProductLine = {
  productId: string
  name: string
  sku: string | null
  category: string | null
  bookQty: number
  batchBookQty: number
  finalQty: number
  variance: number
  varianceValue: number
  counted: boolean
  negativeBook: boolean
  multipleCounters: boolean
  /** Stock moved (a sale, a receipt) after the first count of this product. */
  movedSinceCount: boolean
  batches: ReviewBatchLine[]
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function isSellableOnShelf(batch: ReviewBatch, today: string): boolean {
  const status = batch.status ?? 'active'
  if (status !== 'active' && status !== 'exhausted') return false
  return !batch.expiryDate || batch.expiryDate >= today
}

/** Same order as the RPC: latest expiry first, so uncounted stock stays on fresh batches. */
function compareForUncountedShare(a: ReviewBatch, b: ReviewBatch): number {
  if (a.expiryDate === b.expiryDate) return a.id.localeCompare(b.id)
  if (a.expiryDate === null) return -1
  if (b.expiryDate === null) return 1
  return b.expiryDate.localeCompare(a.expiryDate)
}

export function previewProductPosting(params: {
  product: ReviewProduct
  batches: ReviewBatch[]
  counts: ReviewCount[]
  overrides: ReviewOverride[]
  today: string
  productUpdatedAt?: string | null
}): ReviewProductLine {
  const { product, today } = params
  const batches = params.batches.filter((b) => !!b.id)
  const productCost = Number(product.costPrice ?? 0)
  const countsByKey = new Map<string, ReviewCount[]>()
  for (const count of params.counts) {
    const list = countsByKey.get(count.batchKey) ?? []
    list.push(count)
    countsByKey.set(count.batchKey, list)
  }
  const overrideByKey = new Map(params.overrides.map((o) => [o.batchKey, o]))
  const keys = new Set([...countsByKey.keys(), ...overrideByKey.keys()])
  const counted = keys.size > 0

  const finalByKey = new Map<string, number>()
  for (const key of keys) {
    const override = overrideByKey.get(key)
    const sum = (countsByKey.get(key) ?? []).reduce((total, c) => total + c.countedQty, 0)
    finalByKey.set(key, override ? override.overrideQty : sum)
  }

  const batchByNumber = new Map<string, ReviewBatch>()
  for (const batch of batches) {
    const number = normaliseBatchNumber(batch.batchNumber)
    if (!batchByNumber.has(number)) batchByNumber.set(number, batch)
  }

  // Resolve every key to the batch it lands on.
  const countedByBatchId = new Map<string, number>()
  const newBatchLines: ReviewBatchLine[] = []
  let unbatched = 0
  for (const key of [...keys].sort()) {
    const qty = finalByKey.get(key) ?? 0
    const parsed = parseBatchKey(key)
    if (!parsed) continue
    if (parsed.kind === 'unbatched') {
      unbatched += qty
    } else if (parsed.kind === 'batch') {
      countedByBatchId.set(parsed.batchId, (countedByBatchId.get(parsed.batchId) ?? 0) + qty)
    } else {
      const first = (countsByKey.get(key) ?? [])[0]
      const number = normaliseBatchNumber(first?.newBatchNumber ?? parsed.batchNumber)
      const existing = batchByNumber.get(number)
      if (existing) {
        countedByBatchId.set(existing.id, (countedByBatchId.get(existing.id) ?? 0) + qty)
      } else if (qty > 0) {
        newBatchLines.push(
          line({
            key,
            batchId: null,
            batchNumber: number,
            expiryDate: first?.newExpiryDate ?? null,
            status: 'new',
            bookQty: 0,
            finalQty: qty,
            unitCost: productCost,
            rule: 'new_batch',
          }),
        )
      }
    }
  }

  function line(p: {
    key: string
    batchId: string | null
    batchNumber: string
    expiryDate: string | null
    status: string | null
    bookQty: number
    finalQty: number
    unitCost: number
    rule: PostingRule
  }): ReviewBatchLine {
    const counters = (countsByKey.get(p.key) ?? []).map((c) => ({
      countedBy: c.countedBy,
      countedQty: c.countedQty,
      countedAt: c.countedAt,
    }))
    const override = overrideByKey.get(p.key)
    const sum = counters.reduce((total, c) => total + c.countedQty, 0)
    const variance = p.finalQty - p.bookQty
    return {
      batchKey: p.key,
      batchId: p.batchId,
      batchNumber: p.batchNumber,
      expiryDate: p.expiryDate,
      status: p.status,
      bookQty: p.bookQty,
      countedQty: counters.length > 0 ? sum : null,
      counters,
      overrideQty: override ? override.overrideQty : null,
      overrideReason: override ? override.reason : null,
      finalQty: p.finalQty,
      variance,
      unitCost: p.unitCost,
      varianceValue: roundMoney(variance * p.unitCost),
      rule: p.rule,
    }
  }

  const lines: ReviewBatchLine[] = []
  let remaining = unbatched
  for (const batch of [...batches].sort(compareForUncountedShare)) {
    const book = Number(batch.quantity ?? 0)
    const unitCost = Number(batch.costPrice ?? 0) || productCost
    let finalQty = book
    let rule: PostingRule = 'unchanged'
    if (counted) {
      if (countedByBatchId.has(batch.id)) {
        finalQty = countedByBatchId.get(batch.id) ?? 0
        rule = 'counted'
      } else if (book < 0) {
        finalQty = 0
        rule = 'negative_cleared'
      } else if (isSellableOnShelf(batch, today)) {
        finalQty = Math.min(book, remaining)
        remaining -= finalQty
        rule = 'uncounted_share'
      }
    }
    lines.push(
      line({
        key: batch.id,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        status: batch.status,
        bookQty: book,
        finalQty,
        unitCost,
        rule,
      }),
    )
  }
  if (counted && remaining > 0) {
    lines.push(
      line({
        key: UNBATCHED_KEY,
        batchId: null,
        batchNumber: 'No batch identified',
        expiryDate: null,
        status: 'new',
        bookQty: 0,
        finalQty: remaining,
        unitCost: productCost,
        rule: 'count_batch',
      }),
    )
  } else if (counted && unbatched > 0) {
    // Unbatched count absorbed by existing batches: show it as its own line
    // with no book of its own so the counter's figure stays visible.
    const counters = countsByKey.get(UNBATCHED_KEY) ?? []
    if (counters.length > 0 || overrideByKey.has(UNBATCHED_KEY)) {
      const l = line({
        key: UNBATCHED_KEY,
        batchId: null,
        batchNumber: 'No batch identified (shared across batches)',
        expiryDate: null,
        status: null,
        bookQty: 0,
        finalQty: 0,
        unitCost: productCost,
        rule: 'uncounted_share',
      })
      lines.push({ ...l, finalQty: 0, variance: 0, varianceValue: 0 })
    }
  }
  lines.push(...newBatchLines)

  const batchBookQty = batches.reduce((total, b) => total + Number(b.quantity ?? 0), 0)
  const finalQty = counted
    ? lines.reduce((total, l) => total + l.finalQty, 0)
    : Number(product.quantity ?? 0)
  const bookQty = Number(product.quantity ?? 0)
  // Value: batch movements at batch cost, plus any product/batch drift at product cost.
  const batchValue = lines.reduce((total, l) => total + l.varianceValue, 0)
  const batchFinal = lines.reduce((total, l) => total + l.finalQty, 0)
  const drift = counted ? bookQty - batchBookQty : 0
  const varianceValue = counted ? roundMoney(batchValue - drift * productCost) : 0
  const firstCount = params.counts
    .map((c) => Date.parse(c.countedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0]
  const updatedAt = params.productUpdatedAt ? Date.parse(params.productUpdatedAt) : NaN
  const counterIds = new Set(params.counts.map((c) => c.countedBy))

  return {
    productId: product.id,
    name: product.name,
    sku: product.sku,
    category: product.category,
    bookQty,
    batchBookQty,
    finalQty: counted ? batchFinal : bookQty,
    variance: (counted ? finalQty : bookQty) - bookQty,
    varianceValue,
    counted,
    negativeBook: bookQty < 0,
    multipleCounters: counterIds.size > 1,
    movedSinceCount:
      counted && firstCount !== undefined && Number.isFinite(updatedAt) && updatedAt > firstCount,
    // Uncounted products keep the payload small: 2,000 of them is normal after a cut-over.
    batches: counted ? lines : [],
  }
}

export type StockTakeReviewTotals = {
  productsInScope: number
  productsCounted: number
  productsUncounted: number
  uncountedNegative: number
  productsWithVariance: number
  negativesToClear: number
  unitsGained: number
  unitsLost: number
  valueGained: number
  valueLost: number
  netValue: number
  movedSinceCount: number
  multipleCounters: number
}

export function summariseReview(lines: ReviewProductLine[]): StockTakeReviewTotals {
  const totals: StockTakeReviewTotals = {
    productsInScope: lines.length,
    productsCounted: 0,
    productsUncounted: 0,
    uncountedNegative: 0,
    productsWithVariance: 0,
    negativesToClear: 0,
    unitsGained: 0,
    unitsLost: 0,
    valueGained: 0,
    valueLost: 0,
    netValue: 0,
    movedSinceCount: 0,
    multipleCounters: 0,
  }
  for (const line of lines) {
    if (!line.counted) {
      totals.productsUncounted += 1
      if (line.negativeBook) totals.uncountedNegative += 1
      continue
    }
    totals.productsCounted += 1
    if (line.variance !== 0) totals.productsWithVariance += 1
    if (line.negativeBook && line.finalQty >= 0) totals.negativesToClear += 1
    if (line.variance > 0) totals.unitsGained += line.variance
    if (line.variance < 0) totals.unitsLost -= line.variance
    if (line.varianceValue > 0) totals.valueGained += line.varianceValue
    if (line.varianceValue < 0) totals.valueLost -= line.varianceValue
    if (line.movedSinceCount) totals.movedSinceCount += 1
    if (line.multipleCounters) totals.multipleCounters += 1
  }
  totals.valueGained = roundMoney(totals.valueGained)
  totals.valueLost = roundMoney(totals.valueLost)
  totals.netValue = roundMoney(totals.valueGained - totals.valueLost)
  return totals
}

/** Review order: problems first — negatives not yet counted, then biggest value swings. */
export function sortReviewLines(lines: ReviewProductLine[]): ReviewProductLine[] {
  const rank = (l: ReviewProductLine) => {
    if (!l.counted && l.negativeBook) return 0
    if (l.counted && l.variance !== 0) return 1
    if (!l.counted) return 3
    return 2
  }
  return [...lines].sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    const v = Math.abs(b.varianceValue) - Math.abs(a.varianceValue)
    if (v !== 0) return v
    return a.name.localeCompare(b.name)
  })
}

export function stockTakeReference(now: Date, existingToday: number): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `ST-${y}${m}${d}-${String(existingToday + 1).padStart(2, '0')}`
}

export function kampalaToday(now = new Date()): string {
  // Africa/Kampala is UTC+3 all year.
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** The whole review: one line per product in scope or counted, problems first. */
export function previewStockTakePosting(params: {
  products: Array<ReviewProduct & { updatedAt?: string | null }>
  batches: Array<ReviewBatch & { productId: string }>
  countsByProduct: Map<string, ReviewCount[]>
  overridesByProduct: Map<string, ReviewOverride[]>
  today: string
}): { lines: ReviewProductLine[]; totals: StockTakeReviewTotals } {
  const batchesByProduct = new Map<string, ReviewBatch[]>()
  for (const batch of params.batches) {
    const list = batchesByProduct.get(batch.productId) ?? []
    list.push(batch)
    batchesByProduct.set(batch.productId, list)
  }
  const lines = params.products.map((product) =>
    previewProductPosting({
      product,
      batches: batchesByProduct.get(product.id) ?? [],
      counts: params.countsByProduct.get(product.id) ?? [],
      overrides: params.overridesByProduct.get(product.id) ?? [],
      today: params.today,
      productUpdatedAt: product.updatedAt ?? null,
    }),
  )
  return { lines: sortReviewLines(lines), totals: summariseReview(lines) }
}
