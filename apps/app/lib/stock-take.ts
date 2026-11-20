/**
 * Stock-take logic for the phone: finding items, reading what a counter typed,
 * and deciding what to upload. No React, no SQLite, so it runs under node:test.
 */
import {
  UNBATCHED_KEY,
  batchKeyFor,
  isValidIsoDate,
  kampalaToday,
  normaliseBatchNumber,
  validateCountEntry,
  type CountEntryInput,
} from '../../../packages/db/src/stock-take'

export { UNBATCHED_KEY, batchKeyFor, isValidIsoDate, kampalaToday, normaliseBatchNumber, validateCountEntry }

export type StockTakeStatus = 'counting' | 'review' | 'posted' | 'cancelled'

export type StockTakeView = {
  id: string
  reference: string
  title: string
  scope: 'all' | 'category'
  categories: string[]
  blind: boolean
  status: StockTakeStatus
  notes: string | null
  openedAt: string
  closedAt: string | null
  postedAt: string | null
  postingSummary: Record<string, unknown> | null
  showBook: boolean
  canManage: boolean
}

export type StockTakeBatch = {
  id: string
  batchNumber: string
  expiryDate: string | null
  status: string
  bookQty?: number
}

export type StockTakeItem = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  category: string | null
  unit: string | null
  bookQty?: number
  negativeBook?: boolean
  batches: StockTakeBatch[]
}

export type EntrySyncState = 'pending' | 'synced' | 'rejected' | 'closed'

/** One counted line on this phone: the latest value for a product and batch key. */
export type LocalCountEntry = {
  entryId: string
  stockTakeId: string
  productId: string
  batchKey: string
  batchId: string | null
  newBatchNumber: string | null
  newExpiryDate: string | null
  /** null means "cleared": the counter removed this line. */
  countedQty: number | null
  countedAt: string
  syncState: EntrySyncState
  lastError: string | null
}

// ---------------------------------------------------------------------------
// Finding items
// ---------------------------------------------------------------------------

function normCode(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

/** UPC-A scans as 12 digits, the same code printed as EAN-13 has a leading 0. */
function numericVariants(code: string): string[] {
  if (!/^\d+$/.test(code)) return [code]
  const stripped = code.replace(/^0+/, '')
  return [code, stripped]
}

/**
 * Exact barcode or SKU match. A scan must never fall back to a substring hit:
 * counting the wrong product is worse than counting nothing.
 */
export function findByScan(items: StockTakeItem[], scanned: string): StockTakeItem[] {
  const code = normCode(scanned)
  if (!code) return []
  const wanted = new Set(numericVariants(code))
  return items.filter((item) => {
    const barcode = normCode(item.barcode)
    const sku = normCode(item.sku)
    if (barcode && numericVariants(barcode).some((v) => wanted.has(v))) return true
    return sku !== '' && sku === code
  })
}

export function searchItems(items: StockTakeItem[], query: string, limit = 60): StockTakeItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice(0, limit)
  const words = q.split(/\s+/)
  const scored: Array<{ item: StockTakeItem; score: number }> = []
  for (const item of items) {
    const name = item.name.toLowerCase()
    const sku = normCode(item.sku)
    const barcode = normCode(item.barcode)
    let score = 0
    if (barcode === q || sku === q) score = 100
    else if (name.startsWith(q)) score = 80
    else if (words.every((w) => name.includes(w))) score = 60
    else if (sku.includes(q) || barcode.includes(q)) score = 40
    if (score > 0) scored.push({ item, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map((s) => s.item)
}

// ---------------------------------------------------------------------------
// Reading what was typed
// ---------------------------------------------------------------------------

/**
 * Counted quantity from what the counter typed. Boxes are counted as
 * "3x20+5": three boxes of twenty and five loose. Returns null for nothing
 * typed and NaN for something that is not a count.
 */
export function parseCountInput(raw: string): number | null {
  const text = raw.replace(/\s+/g, '').toLowerCase().replace(/[×*]/g, 'x')
  if (!text) return null
  if (!/^\d+(x\d+)*(\+\d+(x\d+)*)*$/.test(text)) return Number.NaN
  let total = 0
  for (const term of text.split('+')) {
    total += term.split('x').reduce((product, factor) => product * Number(factor), 1)
  }
  return Number.isSafeInteger(total) ? total : Number.NaN
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null
  if (day < 1 || day > lastDayOfMonth(year, month)) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Expiry as printed on a pack. "03/28", "3/2028" and "2028-03" mean the end of
 * March 2028; "15/03/2028" and "2028-03-15" are exact.
 */
export function parseExpiryInput(raw: string): string | null {
  const text = raw.trim().replace(/[.\s]/g, '/').replace(/-/g, '/')
  if (!text) return null
  let m = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]))
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]))
  m = text.match(/^(\d{4})\/(\d{1,2})$/)
  if (m) return iso(Number(m[1]), Number(m[2]), lastDayOfMonth(Number(m[1]), Number(m[2])))
  m = text.match(/^(\d{1,2})\/(\d{2}|\d{4})$/)
  if (m) {
    const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])
    const month = Number(m[1])
    return iso(year, month, month >= 1 && month <= 12 ? lastDayOfMonth(year, month) : 1)
  }
  return null
}

export function formatExpiry(isoDate: string | null | undefined): string {
  if (!isoDate) return 'No expiry'
  const [y, m] = isoDate.split('-')
  return `${m}/${y?.slice(2)}`
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function liveEntries(entries: LocalCountEntry[]): LocalCountEntry[] {
  return entries.filter((e) => e.countedQty !== null)
}

export function entriesForProduct(entries: LocalCountEntry[], productId: string): LocalCountEntry[] {
  return entries.filter((e) => e.productId === productId)
}

/** Units this phone counted for one product, or null when nothing was counted. */
export function countedTotal(entries: LocalCountEntry[], productId: string): number | null {
  const mine = liveEntries(entriesForProduct(entries, productId))
  if (mine.length === 0) return null
  return mine.reduce((total, e) => total + (e.countedQty ?? 0), 0)
}

export type ItemFilter = 'todo' | 'done' | 'negative' | 'all'

export function filterItems(
  items: StockTakeItem[],
  entries: LocalCountEntry[],
  filter: ItemFilter,
): StockTakeItem[] {
  if (filter === 'all') return items
  const counted = new Set(liveEntries(entries).map((e) => e.productId))
  if (filter === 'done') return items.filter((i) => counted.has(i.id))
  if (filter === 'negative') return items.filter((i) => i.negativeBook && !counted.has(i.id))
  return items.filter((i) => !counted.has(i.id))
}

export type CountProgress = {
  total: number
  counted: number
  pending: number
  rejected: number
  percent: number
}

export function countProgress(items: StockTakeItem[], entries: LocalCountEntry[]): CountProgress {
  const ids = new Set(items.map((i) => i.id))
  const counted = new Set(liveEntries(entries).filter((e) => ids.has(e.productId)).map((e) => e.productId))
  const pending = entries.filter((e) => e.syncState === 'pending').length
  const rejected = entries.filter((e) => e.syncState === 'rejected').length
  return {
    total: items.length,
    counted: counted.size,
    pending,
    rejected,
    percent: items.length === 0 ? 0 : Math.round((counted.size / items.length) * 100),
  }
}

// ---------------------------------------------------------------------------
// Editing and syncing
// ---------------------------------------------------------------------------

/**
 * The entry a counter's edit produces. Every edit gets a fresh entry id, so the
 * server can tell a replay (same id) from a correction (new id, later time).
 */
export function buildEntry(params: {
  stockTakeId: string
  productId: string
  batchId?: string | null
  newBatchNumber?: string | null
  newExpiryDate?: string | null
  countedQty: number | null
  newId: () => string
  now?: Date
}): LocalCountEntry {
  const batchKey = batchKeyFor({ batchId: params.batchId, newBatchNumber: params.newBatchNumber })
  return {
    entryId: params.newId(),
    stockTakeId: params.stockTakeId,
    productId: params.productId,
    batchKey,
    batchId: params.batchId ?? null,
    newBatchNumber: params.newBatchNumber ? normaliseBatchNumber(params.newBatchNumber) : null,
    newExpiryDate: params.newBatchNumber ? params.newExpiryDate ?? null : null,
    countedQty: params.countedQty,
    countedAt: (params.now ?? new Date()).toISOString(),
    syncState: 'pending',
    lastError: null,
  }
}

export function toUploadEntry(entry: LocalCountEntry): CountEntryInput {
  return {
    entryId: entry.entryId,
    productId: entry.productId,
    batchId: entry.batchId,
    newBatchNumber: entry.newBatchNumber,
    newExpiryDate: entry.newExpiryDate,
    countedQty: entry.countedQty,
    countedAt: entry.countedAt,
  }
}

export const UPLOAD_BATCH_SIZE = 200

export function nextUploadBatch(entries: LocalCountEntry[], size = UPLOAD_BATCH_SIZE): LocalCountEntry[] {
  return entries
    .filter((e) => e.syncState === 'pending')
    .sort((a, b) => a.countedAt.localeCompare(b.countedAt))
    .slice(0, size)
}

export type UploadResult = {
  entryId: string
  outcome: 'saved' | 'cleared' | 'stale' | 'rejected'
  reason?: string
}

/**
 * New sync state per entry id after an upload. "stale" means the server holds
 * a newer count from this person, which is just as settled as "saved".
 */
export function syncStatesFromResults(
  results: UploadResult[],
): Map<string, { syncState: EntrySyncState; lastError: string | null }> {
  const next = new Map<string, { syncState: EntrySyncState; lastError: string | null }>()
  for (const result of results) {
    if (result.outcome === 'rejected') {
      next.set(result.entryId, { syncState: 'rejected', lastError: result.reason ?? 'Rejected' })
    } else {
      next.set(result.entryId, { syncState: 'synced', lastError: null })
    }
  }
  return next
}

export function describeSyncState(progress: Pick<CountProgress, 'pending' | 'rejected'>, online: boolean | null): string {
  if (progress.rejected > 0) return `${progress.rejected} not accepted — open them to fix`
  if (progress.pending === 0) return 'All counts sent'
  if (online === false) return `${progress.pending} saved on this phone, will send when online`
  return `Sending ${progress.pending}…`
}

export function formatMoney(value: number): string {
  const sign = value < 0 ? '−' : value > 0 ? '+' : ''
  return `${sign}${Math.abs(Math.round(value)).toLocaleString('en-US')}`
}

export function formatSigned(value: number): string {
  if (value > 0) return `+${value}`
  if (value < 0) return `−${Math.abs(value)}`
  return '0'
}
